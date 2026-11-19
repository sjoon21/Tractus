"""Phase 0 실험 1회 실행: 모델 하나 × 데이터셋 하나 × 조건 하나.

    python run.py qwen3-1.7b hike --lang auto
    python run.py whisper-turbo aihub --lang fixed --chunk 30 --glossary
    python run.py qwen3-1.7b aihub --segments label   # VAD 대신 라벨 발화 경계로 30초 이하 묶음 (utt: 발화 하나씩)
    python run.py qwen3-1.7b-onnx aihub --lang auto --glossary --threads 4   # onnxruntime (uv run --with onnxruntime==1.32.0)
    python run.py qwen3-1.7b aihub --lang auto --glossary --app [--vad ../models/silero-vad-v6-onnx]   # 앱 경로 (제품 VAD + Transcriber)
    python run.py qwen3-1.7b-onnx aihub --minutes 8   # 부분 표본: 세션마다 앞 8분 (FLEURS·HiKE는 --every K: K개마다 하나)

결과:
    results/raw/<dataset>/<tag>.jsonl   전사 원문 (git 제외, AI Hub 파생 텍스트 포함)
    results/summary.jsonl               지표 요약 (커밋 대상)
"""

import argparse
import json
import os
import platform
import subprocess
import sys
import time
import traceback
from collections import Counter
from pathlib import Path

os.environ.setdefault("TQDM_DISABLE", "1")

import score  # noqa: E402
from asr import ASR, CAPPED, MODELS, MODELS_DIR, retry_kinds, runtime_of  # noqa: E402
from data import DATASETS, SR, aihub_clean  # noqa: E402
from vad import load_chunks, merge  # noqa: E402

RESULTS = Path(__file__).resolve().parent / "results"
LONG_FORM = {"aihub"}  # VAD 청킹을 거치는 장시간 데이터셋. 나머지는 30초 미만 클립이라 통째로 넣는다.


def raw_path_for(model: str, dataset: str, lang: str, chunk: float | None, glossary: bool, segments: str = "vad",
                 cap: bool = False, app_vad: str | None = None, subset: str | None = None) -> Path:
    """cap: 토큰 상한을 건 측정(옛 상한 없는 원문과 파일을 가른다). app_vad: --app 모드의 VAD 폴더 이름. subset: 부분 표본(head8m·every8)."""
    tag = f"{model}__{lang}" + (f"__c{int(chunk)}" if dataset in LONG_FORM else "") + ("__gloss" if glossary else "")
    tag += "" if segments == "vad" else f"__{segments}"
    tag += "__cap" if cap else ""
    tag += f"__app-{app_vad}" if app_vad else ""
    tag += f"__{subset}" if subset else ""
    return RESULTS / "raw" / dataset / f"{tag}.jsonl"


def peak_rss_gb() -> float:
    """프로세스 최대 메모리. Windows는 PeakWorkingSetSize, 그 밖은 ru_maxrss(macOS 바이트, Linux KB)."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):  # PROCESS_MEMORY_COUNTERS
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (n, ctypes.c_size_t) for n in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage",
                                               "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]

        k32 = ctypes.WinDLL("kernel32")
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        c = Counters(cb=ctypes.sizeof(Counters))
        if not k32.K32GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(c), c.cb):
            raise ctypes.WinError()
        return round(c.PeakWorkingSetSize / 1e9, 2)
    import resource

    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(rss * (1 if sys.platform == "darwin" else 1024) / 1e9, 2)


def machine(power: str | None) -> dict:
    """요약의 cpu 칸: 모델명·논리 코어·설치 RAM(GiB)·전원(소유자가 --power로 적는다)."""
    name, ram = platform.processor() or platform.machine(), None
    try:
        if sys.platform == "darwin":
            name = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip() or name
            ram = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout)
        elif sys.platform == "win32":
            import ctypes
            import winreg

            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
                name = str(winreg.QueryValueEx(k, "ProcessorNameString")[0]).strip()
            kb = ctypes.c_ulonglong()
            if ctypes.windll.kernel32.GetPhysicallyInstalledSystemMemory(ctypes.byref(kb)):
                ram = kb.value * 1024
        else:
            ram = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (OSError, ValueError):
        pass
    return {"name": name, "cores": os.cpu_count(), "ram_gb": round(ram / 2**30) if ram else None, "power": power}


def ort_threads(n: int):
    """onnxruntime 세션의 intra-op 스레드 수를 바꾼다. 제품 어댑터(asr_onnx.OnnxQwen3ASR.load)에 인자가 없어 벤치가 세션 생성을 감싼다."""
    import onnxruntime as ort

    real = ort.InferenceSession

    def session(path, sess_options=None, *a, **kw):
        opts = sess_options or ort.SessionOptions()
        opts.intra_op_num_threads = n
        return real(path, opts, *a, **kw)

    ort.InferenceSession = session


def head(sample, minutes: float):
    """AI Hub 세션의 앞 minutes분: 그 뒤 앞 발화가 모두 끝난 첫 빈틈의 가운데에서 자르고, 정답·구간도 거기까지 줄인다.
    사전(glossary)은 세션 전체 그대로 둔다(사용자 사전처럼 이 구간에 안 나오는 단어도 들어간다). ONNX CPU가 느려 부분 표본으로 잴 때만 쓴다."""
    spans, forms, want, end = sample.meta["spans"], sample.meta["forms"], minutes * 60 * SR, 0
    for k, (s, e) in enumerate(spans):
        if end >= want and s >= end:
            cut = (end + s) // 2
            break
        end = max(end, e)
    else:
        return sample
    meta = {**sample.meta, "spans": spans[:k], "forms": forms[:k], "ref_pron": " ".join(aihub_clean(f, spelling=False) for f in forms[:k])}
    return type(sample)(sample.id, sample.audio[:cut], " ".join(aihub_clean(f) for f in forms[:k]), sample.lang, meta)


class App:
    """앱 경로 (--app): 제품 tractus.vad.find_chunks + tractus.asr.Transcriber.transcribe. 제품 코드는 고치지 않고 _generate를 감싸 재시도를 센다."""

    def __init__(self, name: str, vad_dir: Path):
        from tractus import asr as product

        self.model = product.Transcriber.load(MODELS_DIR / MODELS[name][0])  # ONNX 폴더는 표지 파일로 ONNX 어댑터로 간다
        self.vad_dir = vad_dir
        self.calls: list = []
        self.repaired, self.retries = 0, Counter()
        real = self.model._generate

        def counted(audio, language, hotwords, max_tokens, temperature=0.0):
            self.calls.append((language, hotwords, temperature))
            return real(audio, language, hotwords, max_tokens, temperature)

        self.model._generate = counted

    def chunks(self, audio) -> list[tuple[int, int]]:
        from tractus.vad import find_chunks

        return find_chunks(audio, self.vad_dir)

    def transcribe(self, audio, lang: str | None, glossary: list[str] | None, count: bool = True) -> str:
        self.calls = []
        seg = self.model.transcribe(audio, lang, glossary)
        if count:
            self.repaired += seg.repaired
            self.retries += retry_kinds(self.calls)
        return seg.text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model", choices=MODELS)
    ap.add_argument("dataset", choices=DATASETS)
    ap.add_argument("--lang", choices=["auto", "fixed"], default="fixed")
    ap.add_argument("--chunk", type=float, default=30.0)
    ap.add_argument("--glossary", action="store_true", help="AI Hub 세션의 영문 용어를 용어집으로 넣는다")
    ap.add_argument("--segments", choices=["vad", "label", "utt"], default="vad",
                    help="장시간 데이터셋 자르기: vad(제품과 같은 Silero), label(정답 발화 경계로 --chunk 이하 묶음), utt(정답 발화 하나씩)")
    ap.add_argument("--app", action="store_true", help="앱 경로: 제품 VAD(find_chunks) + Transcriber(재시도·ITN 포함). --segments는 쓰지 않는다")
    ap.add_argument("--vad", type=Path, default=None, help="--app의 VAD 폴더 (기본 models/silero-vad-v6, ONNX는 silero_vad_16k_op15.onnx가 든 폴더)")
    ap.add_argument("--threads", type=int, default=0, help="onnxruntime intra-op 스레드 수 (0: ORT 기본)")
    ap.add_argument("--power", default=None, help="요약 cpu 칸에 남길 전원 조건 (예: 'AC, 최고 성능')")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--minutes", type=float, default=0, help="AI Hub 부분 표본: 세션마다 앞 N분 (발화 사이 빈틈에서 자름)")
    ap.add_argument("--every", type=int, default=0, help="부분 표본: K개마다 하나 (0, K, 2K…번째)")
    ap.add_argument("--only", default="", help="쉼표로 구분한 sample id만 실행")
    args = ap.parse_args()

    long_form = args.dataset in LONG_FORM
    if args.segments != "vad" and args.dataset != "aihub":
        ap.error("--segments label|utt는 aihub만 (정답 발화 구간이 있는 데이터)")
    if args.app and args.segments != "vad":
        ap.error("--app은 제품 VAD로 자른다 (--segments 없이)")
    if args.vad and not args.app:
        ap.error("--vad는 --app과 함께")
    if args.minutes and args.dataset != "aihub":
        ap.error("--minutes는 aihub만 (클립 데이터는 --every)")
    subset = "_".join(filter(None, [f"head{args.minutes:g}m" if args.minutes else "", f"every{args.every}" if args.every else ""])) or None
    vad_dir = (args.vad or MODELS_DIR / "silero-vad-v6").resolve()
    cap = args.app or MODELS[args.model][1] in CAPPED
    raw_path = raw_path_for(args.model, args.dataset, args.lang, args.chunk, args.glossary, args.segments, cap,
                            vad_dir.name if args.app else None, subset)
    tag = raw_path.stem
    raw_path.parent.mkdir(parents=True, exist_ok=True)

    if args.threads:
        ort_threads(args.threads)
    t_load = time.perf_counter()
    asr = App(args.model, vad_dir) if args.app else ASR(args.model)
    load_s = time.perf_counter() - t_load

    only = set(filter(None, args.only.split(",")))
    rows, warmed = [], False
    with raw_path.open("w", encoding="utf-8") as f:
        for i, sample in enumerate(DATASETS[args.dataset]()):
            if only and sample.id not in only or args.every and i % args.every:
                continue
            if args.minutes:
                sample = head(sample, args.minutes)
            if args.limit and len(rows) >= args.limit:
                break
            lang = sample.lang if args.lang == "fixed" else None
            glossary = sample.meta.get("glossary") if args.glossary else None
            if not warmed:  # 첫 호출의 컴파일·캐시 비용을 RTF에서 뺀다
                if args.app:
                    asr.transcribe(sample.audio[: 10 * SR], lang, glossary, count=False)
                else:
                    asr.transcribe(sample.audio[: 10 * SR], lang, glossary)
                warmed = True
            t0 = time.perf_counter()
            cap_hit, parts = 0, []  # cap_hit: 상한에 닿았지만 글에 반복이 안 보이는 청크 (반복 수 = 글의 루프 또는 상한 도달)
            try:
                if args.app:  # 제품처럼 클립도 VAD를 거친다
                    parts = [asr.transcribe(sample.audio[s:e], lang, glossary) for s, e in asr.chunks(sample.audio)]
                else:
                    spans = chunks_for(sample, args.segments, args.chunk) if long_form else [(0, len(sample.audio))]
                    for s, e in spans:
                        parts.append(asr.transcribe(sample.audio[s:e], lang, glossary))
                        cap_hit += asr.capped and not score.repetitions(parts[-1])
                    if args.segments == "utt":  # 발화마다 정답과 짝지어 채점할 수 있게 (score.cer_best)
                        sample.meta["parts"] = parts
                hyp, error = " ".join(p for p in parts if p), None
            except Exception:
                hyp, error = "", traceback.format_exc(limit=3)
            row = {
                "id": sample.id,
                "hyp": hyp,
                "ref": sample.ref,
                "audio_s": len(sample.audio) / SR,
                "proc_s": time.perf_counter() - t0,
                "error": error,
                "meta": sample.meta,
                "empty": sum(not p for p in parts),  # 빈 출력 청크
                **({"cap_hit": cap_hit} if cap_hit else {}),
            }
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            rows.append(row)
            if long_form or i % 100 == 0:
                print(f"[{tag}] {sample.id} {row['audio_s'] / 60:.1f}min proc={row['proc_s']:.0f}s err={bool(error)}", flush=True)

    mx = sys.modules.get("mlx.core")  # MLX를 쓴 측정에서만 (ONNX 측정은 mlx를 불러오지 않는다)
    ort = sys.modules.get("onnxruntime")
    runtime = runtime_of(args.model)
    summary = {
        "model": args.model,
        "dataset": args.dataset,
        "lang": args.lang,
        "chunk_s": args.chunk if long_form else None,
        **({"segments": args.segments} if args.segments != "vad" else {}),
        "glossary": args.glossary,
        "cap": cap,
        **({"subset": subset} if subset else {}),
        **({"app": True, "vad": vad_dir.name, "repaired": asr.repaired, "retries": dict(asr.retries)} if args.app else {}),
        "runtime": runtime,
        "ort_version": ort.__version__ if ort and runtime == "onnxruntime" else None,
        "threads": (args.threads or None) if runtime == "onnxruntime" else None,
        "cpu": machine(args.power),
        "n": len(rows),
        "errors": sum(1 for r in rows if r["error"]),
        "audio_min": round(sum(r["audio_s"] for r in rows) / 60, 1),
        "rtf": round(sum(r["proc_s"] for r in rows) / sum(r["audio_s"] for r in rows), 4),
        "load_s": round(load_s, 1),
        **({"peak_mlx_gb": round(mx.get_peak_memory() / 1e9, 2)} if mx else {}),
        "max_rss_gb": peak_rss_gb(),
        **metrics(args.dataset, rows),
    }
    with (RESULTS / "summary.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(summary, ensure_ascii=False) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=1))


def chunks_for(sample, segments: str, max_s: float) -> list[tuple[int, int]]:
    if segments == "vad":  # 캐시는 세션 전체 경계라 --minutes로 줄인 길이에 맞춰 자른다
        n = len(sample.audio)
        return [(s, min(e, n)) for s, e in load_chunks(sample.id, max_s) if s < n]
    spans = sample.meta["spans"]
    if segments == "label":
        return merge(spans, max_s)
    return [c for span in spans for c in merge([span], max_s)]  # utt: 묶지 않고, max_s보다 긴 발화만 자른다


def metrics(dataset: str, rows: list[dict]) -> dict:
    refs, hyps = [r["ref"] for r in rows], [r["hyp"] for r in rows]
    if dataset == "fleurs":
        return {"cer": round(score.cer(refs, hyps), 2)}
    if dataset == "ami":
        return {"wer": round(score.wer_en(refs, hyps), 2)}
    if dataset == "hike":
        return {"hike": {k: {m: round(x, 2) for m, x in v.items()} for k, v in score.hike_scores(rows).items()}}
    # aihub: 철자전사 기준 CER이 주 지표, 발음전사 기준은 숫자·영문 표기 차이 참고용
    return {
        "cer": round(score.cer(refs, hyps), 2),
        "cer_pron": round(score.cer([r["meta"]["ref_pron"] for r in rows], hyps), 2),
        "repetitions": sum(score.repetitions(r["hyp"]) + r.get("cap_hit", 0) for r in rows),  # 글의 루프 + 상한 도달 청크
        "term_recall": round(score.term_recall(rows), 1),
        **({"empty": sum(r["empty"] for r in rows)} if all("empty" in r for r in rows) else {}),  # 옛 원문에는 없다
        **({"cer_utt": {  # 발화 단위 채점: spelling(철자 그대로) 대비 best(짝마다 가까운 표기), num·latin(그 종류만 고름)
            k: round(score.cer_best(rows, frozenset(v)), 2)
            for k, v in {"spelling": (), "best": ("num", "latin", "other"), "num": ("num",), "latin": ("latin",)}.items()
        }} if all("parts" in r["meta"] for r in rows) else {}),
        "per_session": {
            r["id"]: {"cer": round(score.cer([r["ref"]], [r["hyp"]]), 2), "rtf": round(r["proc_s"] / r["audio_s"], 4)}
            for r in rows
        },
    }


if __name__ == "__main__":
    from data import Sample

    _s = Sample("x", __import__("numpy").zeros(200 * SR), "", "ko", {"spans": [(0, 70 * SR), (65 * SR, 125 * SR), (130 * SR, 140 * SR)],
                                                                     "forms": ["가", "나", "다"], "ref_pron": ""})
    _h = head(_s, 1)  # 1분 넘어 첫 빈틈은 125–130초 (60–70초는 겹친 발화라 자르지 않는다)
    assert (len(_h.audio), _h.ref, _h.meta["forms"]) == (int(127.5 * SR), "가 나", ["가", "나"]), _h
    assert head(_s, 3) is _s
    main()
