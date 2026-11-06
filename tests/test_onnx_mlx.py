"""onnx_mlx: protobuf 읽기와 연산 실행. 작은 ONNX 파일을 테스트 안에서 직접 만들어(onnx 패키지 없이) numpy 계산과 비교한다.
실제 목소리 모델은 slow: onnxruntime 1.30으로 미리 뽑아 둔 임베딩(fixtures/campplus_ort_seed7_t250.npy)과 비교한다."""

import struct
from pathlib import Path

import numpy as np
import pytest

from tractus import onnx_mlx

# ── 최소 protobuf 쓰기 (테스트 전용) ──


def _vint(n: int) -> bytes:
    n &= (1 << 64) - 1
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out += bytes([b | 0x80])
        else:
            return out + bytes([b])


def _f(num: int, v) -> bytes:
    if isinstance(v, int):
        return _vint(num << 3) + _vint(v)
    if isinstance(v, str):
        v = v.encode()
    return _vint(num << 3 | 2) + _vint(len(v)) + v


def tensor(name: str, a: np.ndarray) -> bytes:
    dt = {np.dtype(np.float32): 1, np.dtype(np.int64): 7}[a.dtype]
    return b"".join(_f(1, d) for d in a.shape) + _f(2, dt) + _f(8, name) + _f(9, a.tobytes())


def attr_ints(name: str, xs: list[int]) -> bytes:
    return _f(1, name) + b"".join(_f(8, x) for x in xs) + _f(20, 7)


def attr_int(name: str, x: int) -> bytes:
    return _f(1, name) + _f(3, x) + _f(20, 2)


def attr_float(name: str, x: float) -> bytes:
    return _f(1, name) + _vint(2 << 3 | 5) + struct.pack("<f", x) + _f(20, 1)


def node(op: str, ins: list[str], outs: list[str], *attrs: bytes) -> bytes:
    return b"".join(_f(1, i) for i in ins) + b"".join(_f(2, o) for o in outs) + _f(4, op) + b"".join(_f(5, a) for a in attrs)


def model(nodes: list[bytes], weights: dict[str, np.ndarray], meta: dict[str, str] | None = None) -> bytes:
    g = b"".join(_f(1, n) for n in nodes) + b"".join(_f(5, tensor(k, v)) for k, v in weights.items())
    g += _f(11, _f(1, "x")) + _f(12, _f(1, "y"))
    return _f(7, g) + b"".join(_f(14, _f(1, k) + _f(2, v)) for k, v in (meta or {}).items())


# ── 테스트 ──


def test_small_graph_matches_numpy(tmp_path: Path):
    rng = np.random.default_rng(0)
    w = rng.standard_normal((3, 4, 3)).astype(np.float32)
    b = rng.standard_normal(3).astype(np.float32)
    scale, bias = np.array([1.0, 2.0, 0.5], np.float32), np.array([0.1, -0.2, 0.3], np.float32)
    mean, var = np.array([0.2, -0.1, 0.0], np.float32), np.array([1.0, 4.0, 0.25], np.float32)
    nodes = [
        node("Conv", ["x", "w", "b"], ["c"], attr_ints("kernel_shape", [3]), attr_ints("pads", [1, 1]), attr_ints("strides", [1]), attr_ints("dilations", [1]), attr_int("group", 1)),
        node("BatchNormalization", ["c", "scale", "bias", "mean", "var"], ["n"], attr_float("epsilon", 1e-5)),
        node("Relu", ["n"], ["r"]),
        node("AveragePool", ["r"], ["p"], attr_ints("kernel_shape", [4]), attr_ints("strides", [4]), attr_int("ceil_mode", 1), attr_ints("pads", [0, 0])),
        node("ReduceMean", ["p"], ["y"], attr_ints("axes", [-1]), attr_int("keepdims", 0)),
    ]
    p = tmp_path / "m.onnx"
    p.write_bytes(model(nodes, {"w": w, "b": b, "scale": scale, "bias": bias, "mean": mean, "var": var}, {"sample_rate": "16000"}))
    g = onnx_mlx.load(p)
    assert (g.inputs, g.outputs, g.meta) == (["x"], ["y"], {"sample_rate": "16000"})

    x = rng.standard_normal((1, 4, 10)).astype(np.float32)
    got = onnx_mlx.run(g, {"x": x})[0]

    xp = np.pad(x, ((0, 0), (0, 0), (1, 1)))
    c = np.stack([np.einsum("oik,ik->o", w, xp[0, :, t : t + 3]) for t in range(10)], axis=1)[None] + b[None, :, None]
    n = (c - mean[None, :, None]) / np.sqrt(var[None, :, None] + 1e-5) * scale[None, :, None] + bias[None, :, None]
    r = np.maximum(n, 0)
    pooled = np.stack([r[:, :, 0:4].mean(2), r[:, :, 4:8].mean(2), r[:, :, 8:10].mean(2)], axis=2)  # 마지막 창은 2칸으로 나눈다
    np.testing.assert_allclose(got, pooled.mean(-1), rtol=1e-5, atol=1e-5)


def test_unknown_op_is_refused_before_running(tmp_path: Path):
    p = tmp_path / "m.onnx"
    p.write_bytes(model([node("LSTM", ["x"], ["y"])], {}))
    with pytest.raises(ValueError, match="LSTM"):
        onnx_mlx.load(p)


def test_negative_ints_and_shape_ops(tmp_path: Path):
    nodes = [
        node("Shape", ["x"], ["s"]),
        node("Reshape", ["x", "shape"], ["y"]),
    ]
    p = tmp_path / "m.onnx"
    p.write_bytes(model(nodes, {"shape": np.array([0, -1], np.int64)}))
    y = onnx_mlx.run(onnx_mlx.load(p), {"x": np.ones((2, 3, 4), np.float32)})[0]
    assert y.shape == (2, 12)


@pytest.mark.slow
def test_real_voice_model_matches_onnxruntime_reference():
    from tractus import paths, voices

    p = voices.model_path(paths.models_dir())
    if not voices.model_present(paths.models_dir()):
        pytest.skip("목소리 모델 없음")
    x = np.random.default_rng(7).standard_normal((1, 250, 80)).astype(np.float32)
    got = onnx_mlx.run(onnx_mlx.load(p), {"x": x})[0][0]
    want = np.load(Path(__file__).parent / "fixtures/campplus_ort_seed7_t250.npy")
    assert float(got @ want / np.linalg.norm(got) / np.linalg.norm(want)) > 0.9999
    assert np.abs(got - want).max() < 1e-3
