"""작은 ONNX 실행기: 목소리 프로필의 CAM++ ONNX(voices.MODEL_FILE)를 MLX로 돌린다 (ARCHITECTURE v3.99).

onnxruntime(번들 약 75MB)을 빼려고 만들었다. 받는 파일·sha256은 그대로이고, 그래프를 그대로 실행하므로 모델 구조를 다시 짜지 않는다.
- 읽기: ONNX는 protobuf다. 쓰는 필드만 직접 읽는다(그래프의 노드·속성·가중치·입출력·메타데이터). `onnx` 패키지가 필요 없다.
- 실행: 이 모델이 쓰는 연산만 안다(`OPS`). 모르는 연산이 있으면 실행 전에 오류다(조용히 틀리지 않게).
  모양 계산(Shape·Gather·Concat…)은 numpy, 실수 텐서는 MLX로 한다.
결과가 onnxruntime과 같은지는 tests/test_onnx_mlx.py(가짜 그래프)와 `pytest -m slow`(실제 모델과 onnxruntime 비교, 개발 환경에만 있을 때)가 본다.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# ── protobuf 읽기 (wire format: https://protobuf.dev/programming-guides/encoding/) ──


def _varint(b: bytes, i: int) -> tuple[int, int]:
    shift = out = 0
    while True:
        c = b[i]
        i += 1
        out |= (c & 0x7F) << shift
        if c < 0x80:
            return out, i
        shift += 7


def _fields(b: bytes):
    """(필드 번호, wire type, 값) 차례로. 값은 varint면 int, 길이 구분이면 bytes, 고정 32·64비트면 bytes"""
    i, n = 0, len(b)
    while i < n:
        key, i = _varint(b, i)
        num, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(b, i)
        elif wt == 1:
            v, i = b[i : i + 8], i + 8
        elif wt == 2:
            ln, i = _varint(b, i)
            v, i = b[i : i + ln], i + ln
        elif wt == 5:
            v, i = b[i : i + 4], i + 4
        else:
            raise ValueError(f"protobuf wire type {wt}")
        yield num, wt, v


def _ints(wt: int, v) -> list[int]:
    """반복 int64: 묶인(packed) 것과 하나씩인 것 둘 다. 음수는 64비트 2의 보수"""
    vals = [v] if wt == 0 else _packed_varints(v)
    return [x - (1 << 64) if x >= 1 << 63 else x for x in vals]


def _packed_varints(b: bytes) -> list[int]:
    out, i = [], 0
    while i < len(b):
        x, i = _varint(b, i)
        out.append(x)
    return out


_DTYPES = {1: np.float32, 6: np.int32, 7: np.int64, 9: np.bool_, 11: np.float64}


def _tensor(b: bytes) -> tuple[str, np.ndarray]:
    dims: list[int] = []
    dtype, name, raw = 1, "", None
    floats: list[float] = []
    ints: list[int] = []
    for num, wt, v in _fields(b):
        if num == 1:
            dims += _ints(wt, v)
        elif num == 2:
            dtype = v
        elif num == 4:
            floats += list(struct.unpack(f"<{len(v) // 4}f", v)) if wt == 2 else [struct.unpack("<f", v)[0]]
        elif num in (5, 7):
            ints += _ints(wt, v)
        elif num == 8:
            name = v.decode()
        elif num == 9:
            raw = v
        elif num == 14 and v == 1:  # data_location = EXTERNAL
            raise ValueError("ONNX external_data is not supported")
    if dtype not in _DTYPES:
        raise ValueError(f"ONNX tensor data_type {dtype} is not supported")
    dt = _DTYPES[dtype]
    if raw is not None:
        a = np.frombuffer(raw, dtype=dt).copy()
    else:
        a = np.array(floats if dt in (np.float32, np.float64) else ints, dtype=dt)
    return name, a.reshape(dims) if dims else a.reshape(())


def _attr(b: bytes) -> tuple[str, object]:
    name, val = "", None
    floats: list[float] = []
    ints: list[int] = []
    for num, wt, v in _fields(b):
        if num == 1:
            name = v.decode()
        elif num == 2:
            val = struct.unpack("<f", v)[0]
        elif num == 3:
            val = _ints(0, v)[0]
        elif num == 4:
            val = v.decode()
        elif num == 5:
            val = _tensor(v)[1]
        elif num == 7:
            floats += list(struct.unpack(f"<{len(v) // 4}f", v)) if wt == 2 else [struct.unpack("<f", v)[0]]
        elif num == 8:
            ints += _ints(wt, v)
    if val is None:
        val = ints if ints else floats
    return name, val


@dataclass
class Node:
    op: str
    inputs: list[str]
    outputs: list[str]
    attrs: dict = field(default_factory=dict)


@dataclass
class Graph:
    nodes: list[Node]
    weights: dict[str, np.ndarray]
    inputs: list[str]
    outputs: list[str]
    meta: dict[str, str]


def _node(b: bytes) -> Node:
    n = Node("", [], [])
    for num, _, v in _fields(b):
        if num == 1:
            n.inputs.append(v.decode())
        elif num == 2:
            n.outputs.append(v.decode())
        elif num == 4:
            n.op = v.decode()
        elif num == 5:
            k, a = _attr(v)
            n.attrs[k] = a
    return n


def _value_name(b: bytes) -> str:
    return next((v.decode() for num, _, v in _fields(b) if num == 1), "")


def load(path: Path) -> Graph:
    """ONNX 파일 → 그래프. 그래프 입력 중 가중치인 것은 입력에서 뺀다"""
    model = Path(path).read_bytes()
    graph_b, meta = None, {}
    for num, _, v in _fields(model):
        if num == 7:
            graph_b = v
        elif num == 14:
            kv = {k: x.decode() for k, _, x in _fields(v)}
            meta[kv.get(1, "")] = kv.get(2, "")
    if graph_b is None:
        raise ValueError("ONNX file has no graph")
    g = Graph([], {}, [], [], meta)
    for num, _, v in _fields(graph_b):
        if num == 1:
            g.nodes.append(_node(v))
        elif num == 5:
            k, a = _tensor(v)
            g.weights[k] = a
        elif num == 11:
            g.inputs.append(_value_name(v))
        elif num == 12:
            g.outputs.append(_value_name(v))
    g.inputs = [x for x in g.inputs if x not in g.weights]
    unknown = sorted({n.op for n in g.nodes} - OPS.keys())
    if unknown:
        raise ValueError(f"unsupported ONNX ops: {', '.join(unknown)}")
    return g


# ── 실행 ──


def _is_np(x) -> bool:
    return isinstance(x, (np.ndarray, np.generic))


def _mx(x):
    import mlx.core as mx

    return mx.array(x) if _is_np(x) else x


def _binary(f_np, f_mx):
    def op(n, a, b):
        return f_np(a, b) if _is_np(a) and _is_np(b) else f_mx(_mx(a), _mx(b))

    return op


def _conv(n: Node, x, w, b=None):
    import mlx.core as mx

    k = len(n.attrs["kernel_shape"])
    pads = n.attrs.get("pads", [0] * 2 * k)
    if pads[:k] != pads[k:] or n.attrs.get("group", 1) != 1:
        raise ValueError("Conv with asymmetric pads or group != 1 is not supported")
    strides, dil = n.attrs.get("strides", [1] * k), n.attrs.get("dilations", [1] * k)
    x, w = _mx(x), _mx(w)
    if k == 1:  # NCL → NLC, 가중치 (O, I, k) → (O, k, I)
        y = mx.conv1d(x.transpose(0, 2, 1), w.transpose(0, 2, 1), stride=strides[0], padding=pads[0], dilation=dil[0]).transpose(0, 2, 1)
    else:  # NCHW → NHWC, 가중치 (O, I, kh, kw) → (O, kh, kw, I)
        y = mx.conv2d(x.transpose(0, 2, 3, 1), w.transpose(0, 2, 3, 1), stride=tuple(strides), padding=tuple(pads[:2]), dilation=tuple(dil)).transpose(0, 3, 1, 2)
    if b is not None:
        y = y + _mx(b).reshape((1, -1) + (1,) * k)
    return y


def _batchnorm(n: Node, x, scale, bias, mean, var):
    import mlx.core as mx

    shape = (1, -1) + (1,) * (len(x.shape) - 2)
    r = lambda a: _mx(a).reshape(shape)  # noqa: E731
    return (_mx(x) - r(mean)) * mx.rsqrt(r(var) + n.attrs.get("epsilon", 1e-5)) * r(scale) + r(bias)


def _avgpool(n: Node, x):
    """1차원, pads 0. ceil_mode면 마지막 짧은 창은 실제 칸 수로 나눈다(PyTorch·onnxruntime 1.29 이상과 같다)"""
    import mlx.core as mx

    (k,), (s,) = n.attrs["kernel_shape"], n.attrs.get("strides", n.attrs["kernel_shape"])
    if any(n.attrs.get("pads", [0, 0])) or len(x.shape) != 3:
        raise ValueError("AveragePool supports 1-D without pads only")
    length = x.shape[2]
    if n.attrs.get("ceil_mode", 0):
        count = -(-(length - k) // s) + 1
        if (count - 1) * s >= length:  # 마지막 창은 입력 안에서 시작해야 한다 (PyTorch 규칙)
            count -= 1
    else:
        count = (length - k) // s + 1
    if count < 1:
        raise ValueError("AveragePool input is shorter than the window")
    return mx.stack([x[:, :, i * s : min(i * s + k, length)].mean(axis=2) for i in range(count)], axis=2)


def _reshape(n: Node, x, shape):
    shape = [int(d) for d in np.asarray(shape)]
    shape = [x.shape[i] if d == 0 else d for i, d in enumerate(shape)]
    return x.reshape(shape)


def _unsqueeze(n: Node, x, axes=None):
    axes = [int(a) for a in (np.asarray(axes) if axes is not None else n.attrs["axes"])]
    rank = len(x.shape) + len(axes)
    for a in sorted(a % rank for a in axes):
        x = np.expand_dims(x, a) if _is_np(x) else x.reshape(x.shape[:a] + (1,) + x.shape[a:])
    return x


def _squeeze(n: Node, x, axes=None):
    axes = axes if axes is not None else n.attrs.get("axes")
    if axes is None:
        axes = [i for i, d in enumerate(x.shape) if d == 1]
    axes = tuple(int(a) % len(x.shape) for a in np.asarray(axes).reshape(-1))
    return np.squeeze(x, axes) if _is_np(x) else x.squeeze(axes)


def _slice(n: Node, x, starts, ends, axes=None, steps=None):
    starts, ends = np.asarray(starts).reshape(-1), np.asarray(ends).reshape(-1)
    axes = np.asarray(axes).reshape(-1) if axes is not None else np.arange(len(starts))
    steps = np.asarray(steps).reshape(-1) if steps is not None else np.ones(len(starts), np.int64)
    idx = [slice(None)] * len(x.shape)
    big = 2**62  # ONNX는 '끝까지'를 INT64_MAX로 적는다
    for s, e, a, st in zip(starts, ends, axes, steps):
        idx[int(a)] = slice(int(s), None if int(e) >= big else int(e), int(st))
    return x[tuple(idx)]


def _expand(n: Node, x, shape):
    import mlx.core as mx

    target = tuple(np.broadcast_shapes(tuple(x.shape), tuple(int(d) for d in np.asarray(shape))))
    return np.broadcast_to(x, target) if _is_np(x) else mx.broadcast_to(x, target)


def _reduce(f_np, f_mx):
    def op(n, x, axes=None):
        axes = n.attrs.get("axes") if axes is None else [int(a) for a in np.asarray(axes).reshape(-1)]
        keep = bool(n.attrs.get("keepdims", 1))
        ax = tuple(axes) if axes else None
        return f_np(x, axis=ax, keepdims=keep) if _is_np(x) else f_mx(x, axis=ax, keepdims=keep)

    return op


def _cast(n: Node, x):
    import mlx.core as mx

    to = _DTYPES[n.attrs["to"]]
    if _is_np(x):
        return x.astype(to)
    return x.astype(mx.float32) if to == np.float32 else x


def _gather(n: Node, x, idx):
    import mlx.core as mx

    axis = n.attrs.get("axis", 0)
    if _is_np(x) and _is_np(idx):
        return np.take(x, idx, axis=axis)
    return mx.take(_mx(x), _mx(np.asarray(idx)), axis=axis)


def _concat(n: Node, *xs):
    import mlx.core as mx

    if all(_is_np(x) for x in xs):
        return np.concatenate(xs, axis=n.attrs["axis"])
    return mx.concatenate([_mx(x) for x in xs], axis=n.attrs["axis"])


def _unary(f_np, f_mx_name):
    def op(n, x):
        import mlx.core as mx

        return f_np(x) if _is_np(x) else getattr(mx, f_mx_name)(x)

    return op


OPS = {
    "Constant": lambda n: n.attrs["value"],
    "Shape": lambda n, x: np.array(x.shape, np.int64),
    "Gather": _gather,
    "Unsqueeze": _unsqueeze,
    "Squeeze": _squeeze,
    "Concat": _concat,
    "Reshape": _reshape,
    "Transpose": lambda n, x: np.transpose(x, n.attrs["perm"]) if _is_np(x) else x.transpose(n.attrs["perm"]),
    "ConstantOfShape": lambda n, shape: np.full([int(d) for d in np.asarray(shape)], n.attrs["value"].reshape(-1)[0] if "value" in n.attrs else 0.0, dtype=n.attrs["value"].dtype if "value" in n.attrs else np.float32),
    "Equal": lambda n, a, b: np.equal(a, b),
    "Where": lambda n, c, a, b: np.where(c, a, b),
    "Expand": _expand,
    "Slice": _slice,
    "Cast": _cast,
    "Add": _binary(np.add, lambda a, b: a + b),
    "Sub": _binary(np.subtract, lambda a, b: a - b),
    "Mul": _binary(np.multiply, lambda a, b: a * b),
    "Div": _binary(np.divide, lambda a, b: a / b),
    "Relu": lambda n, x: np.maximum(x, 0) if _is_np(x) else _relu(x),
    "Sigmoid": _unary(lambda x: 1 / (1 + np.exp(-x)), "sigmoid"),
    "Sqrt": _unary(np.sqrt, "sqrt"),
    "ReduceMean": _reduce(np.mean, lambda x, axis, keepdims: x.mean(axis=axis, keepdims=keepdims)),
    "ReduceProd": _reduce(np.prod, lambda x, axis, keepdims: x.prod(axis=axis, keepdims=keepdims)),
    "Conv": _conv,
    "BatchNormalization": _batchnorm,
    "AveragePool": _avgpool,
}


def _relu(x):
    import mlx.core as mx

    return mx.maximum(x, 0)


def run(g: Graph, feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
    """그래프를 노드 순서대로(ONNX는 위상 정렬돼 있다) 실행해 출력을 numpy로"""
    vals: dict[str, object] = {**g.weights, **{k: _mx(np.asarray(v, np.float32)) for k, v in feeds.items()}}
    vals[""] = None  # 빠진 선택 입력
    for n in g.nodes:
        out = OPS[n.op](n, *[vals[i] for i in n.inputs])
        vals[n.outputs[0]] = out
    return [np.array(_mx(vals[o])) for o in g.outputs]
