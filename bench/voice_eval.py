"""목소리 프로필(v3.13) 평가: AI Hub 화자 라벨로 화자 임베딩 모델을 비교하고 THRESHOLD를 정한다.

!!! AI Hub 데이터는 반출 금지다. 지표만 출력한다. 오디오·전사·임베딩·파일 이름은 어디에도 쓰지 않는다.
세션은 s1..sN, 화자는 세션 안 순번으로만 다룬다.

    uv run --with soundfile python bench/voice_eval.py [모델키 ...]   # 저장소 루트에서 (tractus.voices 임베더를 그대로 쓴다)
    # → bench/results/voice_summary.json (지표만)

AI Hub 화자 ID(DG0001…)는 세션마다 새로 붙는다. 기본(정답 = AI Hub 라벨)은 세션이 다르면 다른 사람이다.
ALIASES는 "같은 사람일지도 모르는" 쌍을 묶은 민감도 행(`production_alias`)에만 쓴다. 검증된 정답이 아니다.

(a) 검증 쌍: 발화 1개(1.5–10초) 임베딩끼리 cosine. 같은 사람(같은 세션) 대 다른 사람(같은 세션 / 다른 세션).
(b) 제품 절차: 세션 앞 절반에서 가장 긴 3개 클립으로 등록(정규화 평균), 뒤 절반을 시간순 3개씩 묶어
    "다른 회의의 같은 라벨"로 보고 정규화 평균 → 등록과 cosine.
(c) 매칭 시뮬레이션: (b)의 등록 전원을 사람 목록으로, 세션의 n번째 묶음들을 한 회의로 보고 voices.match 규칙
    (헝가리안 1:1, score >= T, 2등과 차이 >= 0.08)으로 제안. 닫힌 조건(본인 등록됨)의 맞음/틀림/없음과
    열린 조건(본인 등록을 빼고 다시 매칭)에서 그 화자에게 누군가 제안된 비율(오제안)을 임계값별로 잰다.
(d) 세션 간: ALIASES 쌍만 한 세션에서 등록하고 다른 세션 probe와 cosine. 회의가 바뀌는 실제 사용에 가장 가깝지만 1쌍뿐이다.
(b)·(c)는 등록과 probe가 같은 녹음(같은 방·마이크·날)이다. 다른 회의에서의 재현율은 (d) 말고는 재지 못한다.
"""

import glob
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.optimize import linear_sum_assignment

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
from tractus.voices import VoiceEmbedder  # noqa: E402  제품과 같은 특징·런타임(onnxruntime + kaldi-native-fbank)
DATA = ROOT / "data/aihub-meeting"
OUT = Path(__file__).resolve().parent / "results/voice_summary.json"
SR = 16000
MIN_S, MAX_S = 1.5, 10.0  # voices.py 클립 범위와 같다
PER_SPK = 60  # ponytail: 화자당 발화 상한(시간순 균등 추출). 세션 4개라 전부 돌려도 되지만 큰 화자 쏠림만 막는다.
MARGIN = 0.08
SWEEP = [round(x, 2) for x in np.arange(0.30, 0.86, 0.05)]
# 같은 프로그램(같은 분야, 7주 차이) 두 세션의 사회자. 다른 세션 비대상 상위가 전부 이 쌍이다(CAM++ 등록끼리 약 0.9).
# 모델 점수로 정답을 고친 것이라 검증되지 않았다. AI Hub 화자 메타데이터는 성별·역할만 같고 연령대·직업이 달라 오히려 다른 사람 쪽이다.
# 그래서 기본 지표에서는 다른 사람으로 두고, 이 묶음은 민감도 행과 세션 간 시험(d)에만 쓴다.
ALIASES = {(2, 0): (0, 5)}
RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/"

# 3D-Speaker 계열만 (VoiceEmbedder가 그 특징 추출만 한다). NeMo TitaNet은 특징 추출이 달라 sherpa-onnx 없이는 못 돌려 뺐다.
MODELS = {
    "campplus-zh-en": ("3dspeaker-campplus-zh-en", "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx", "Apache-2.0"),
    "eres2netv2-zh-cn": ("3dspeaker-eres2netv2-zh-cn", "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx", "Apache-2.0"),
    "eres2net-base-200k-zh-cn": ("3dspeaker-eres2net-base-200k-zh-cn", "3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx", "Apache-2.0"),
}


def sessions():
    """[(오디오, [(시작, 끝, 화자 순번)])]. 화자 '?'·'(())'·1.5초 미만은 뺀다. 긴 발화는 앞 10초만."""
    out = []
    for jf in sorted(glob.glob(str(DATA / "라벨링데이터/*/*/*/*.json"))):
        d = json.loads(Path(jf).read_text(encoding="utf-8"))
        a, sr = sf.read(next((DATA / "원천데이터").rglob(f"{d['metadata']['title']}.wav")), dtype="float32")
        assert sr == SR
        spk_ix, utts = {}, []
        for u in d["utterance"]:
            s, e = float(u["start"]), float(u["end"])
            if u["speaker_id"] == "?" or u["form"].strip() == "(())" or e - s < MIN_S:
                continue
            utts.append((s, min(e, s + MAX_S), spk_ix.setdefault(u["speaker_id"], len(spk_ix))))
        by = {}
        for x in utts:
            by.setdefault(x[2], []).append(x)
        kept = []
        for xs in by.values():  # 시간순 균등 추출
            kept += [xs[i] for i in np.linspace(0, len(xs) - 1, min(PER_SPK, len(xs))).astype(int)] if len(xs) > PER_SPK else xs
        out.append((a, sorted(set(kept))))
    return out


def norm(v):
    return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-9)


def embedder(key):
    d, f, _ = MODELS[key]
    return VoiceEmbedder(ROOT / "models" / d / f).embed


def eer_and_thresholds(tar, non):
    tar, non = np.sort(tar), np.sort(non)
    ths = np.unique(np.concatenate([tar, non]))
    frr = np.searchsorted(tar, ths, side="left") / len(tar)  # score < th → 거부
    far = 1 - np.searchsorted(non, ths, side="left") / len(non)  # score >= th → 수락
    i = np.argmin(np.abs(frr - far))
    r = {"eer_pct": round(100 * (frr[i] + far[i]) / 2, 2), "eer_threshold": round(float(ths[i]), 3)}
    for name, lim in (("far1", 0.01), ("far0.1", 0.001)):
        j = np.argmax(far <= lim)  # far는 감소: 처음 lim 이하가 되는 임계값
        r[f"th_{name}"], r[f"frr_at_{name}_pct"] = round(float(ths[j]), 3), round(100 * float(frr[j]), 2)
    r |= {"n_target": int(len(tar)), "n_nontarget": int(len(non))}
    return r


def pid(si, k, aliases):
    return aliases.get((si, k), (si, k))


def pair_trials(sess_embs):
    """(a) 발화 쌍. 같은 세션 대상/비대상, 다른 세션 비대상 (AI Hub 라벨). 세션 간 대상 평균은 ALIASES 쌍에서만 나온다."""
    E = np.concatenate([e for e, _ in sess_embs])
    ses = np.concatenate([np.full(len(s), i) for i, (_, s) in enumerate(sess_embs)])
    names = {}
    who = np.array([names.setdefault(pid(si, int(k), ALIASES), len(names)) for si, (_, s) in enumerate(sess_embs) for k in s])
    S = E @ E.T
    iu = np.triu_indices(len(E), 1)
    sc, same_ses, same = S[iu], ses[iu[0]] == ses[iu[1]], who[iu[0]] == who[iu[1]]
    return {
        "same_session": eer_and_thresholds(sc[same & same_ses], sc[same_ses & ~same]),
        "all_labels": eer_and_thresholds(sc[same & same_ses], sc[~(same & same_ses)]),  # AI Hub 라벨 그대로: 다른 세션은 전부 비대상
        "same_session_target_mean": round(float(sc[same & same_ses].mean()), 3),
        "cross_session_target_mean_alias": round(float(sc[same & ~same_ses].mean()), 3),  # ALIASES 1쌍뿐, 미검증
        "cross_session_nontarget_mean": round(float(sc[~same_ses & ~same].mean()), 3),
    }


def enrol_probe(sess, sess_embs):
    """(b) 앞 절반 → 등록(긴 3개), 뒤 절반 → 3개 묶음 probe. people: [(세션, 화자, 벡터)], probes: {(세션, 묶음): {화자: 벡터}}"""
    people, probes = [], {}
    for si, ((_, utts), (E, spk)) in enumerate(zip(sess, sess_embs)):
        for k in np.unique(spk):
            ix = np.flatnonzero(spk == k)  # utts는 시간순
            if len(ix) < 6:
                continue
            half = len(ix) // 2
            first, rest = ix[:half], ix[half:]
            top3 = sorted(first, key=lambda i: utts[i][1] - utts[i][0], reverse=True)[:3]
            people.append((si, int(k), norm(E[top3].mean(0))))
            for g in range(len(rest) // 3):
                probes.setdefault((si, g), {})[int(k)] = norm(E[rest[3 * g : 3 * g + 3]].mean(0))
    return people, probes


def match(spk_embs, people, th):
    """voices.match와 같은 규칙. spk_embs: {라벨: 벡터}, people: [(id, 벡터)] → {라벨: (id, score)}"""
    if not spk_embs or not people:
        return {}
    labels = list(spk_embs)
    S = np.stack([spk_embs[l] for l in labels]) @ np.stack([v for _, v in people]).T
    rows, cols = linear_sum_assignment(-S)
    out = {}
    for r, c in zip(rows, cols):
        others = np.delete(S[r], c)
        second = others.max() if len(others) else -1.0
        if S[r, c] >= th and S[r, c] - second >= MARGIN:
            out[labels[r]] = (people[c][0], float(S[r, c]))
    return out


def production(sess, sess_embs, aliases):
    people, probes = enrol_probe(sess, sess_embs)
    samples = {}
    for si, k, v in people:  # 같은 사람의 등록은 샘플로 모은다(voices.json과 같다): 중심 = 샘플 정규화 평균
        samples.setdefault(pid(si, k, aliases), []).append(v)
    pv = {p: norm(np.mean(vs, 0)) for p, vs in samples.items()}
    probes = {key: {pid(key[0], k, aliases): v for k, v in g.items()} for key, g in probes.items()}
    tar, non = [], []
    for group in probes.values():
        for k, v in group.items():
            for p, w in pv.items():
                (tar if p == k else non).append(float(v @ w))
    res = {"trials": eer_and_thresholds(np.array(tar), np.array(non)), "people": len(pv), "probes": sum(len(g) for g in probes.values())}
    plist = list(pv.items())
    sweep = []
    for th in SWEEP:
        c = {"correct": 0, "wrong": 0, "none": 0, "open_false": 0, "n": 0}
        for group in probes.values():
            got = match(group, plist, th)
            for k in group:
                c["n"] += 1
                hit = got.get(k)
                c["none" if hit is None else "correct" if hit[0] == k else "wrong"] += 1
                # 열린 조건: 이 화자만 등록에서 빼고 같은 회의를 다시 매칭
                if k in match(group, [p for p in plist if p[0] != k], th):
                    c["open_false"] += 1
        n = c.pop("n")
        sweep.append({"threshold": th, "n": n} | {f"{k}_pct": round(100 * v / n, 2) for k, v in c.items()})
    res["match_sweep"] = sweep
    return res


def cross_session(sess, sess_embs):
    """(d) ALIASES 쌍: 한 세션의 등록(3개 클립 중심)을 다른 세션의 3개 묶음 probe와 비교. 같은 세션 probe 점수도 같이 낸다."""
    people, probes = enrol_probe(sess, sess_embs)
    enr = {(si, k): v for si, k, v in people}
    pairs = [(a, b) for a, b in ALIASES.items()] + [(b, a) for a, b in ALIASES.items()]
    same, cross = [], []
    for (sa, ka), (sb, kb) in pairs:
        if (sa, ka) not in enr:
            continue
        v = enr[(sa, ka)]
        same += [float(v @ g[ka]) for (si, _), g in probes.items() if si == sa and ka in g]
        cross += [float(v @ g[kb]) for (si, _), g in probes.items() if si == sb and kb in g]

    def stats(xs):
        xs = np.array(xs)
        return {"n": int(len(xs)), "mean": round(float(xs.mean()), 3), "min": round(float(xs.min()), 3),
                "p10": round(float(np.percentile(xs, 10)), 3)} | {f"ge_{t}_pct": round(100 * float((xs >= t).mean()), 1) for t in (0.65, 0.70, 0.75, 0.80)}

    return {"pairs": len(ALIASES), "same_session_probes": stats(same), "cross_session_probes": stats(cross)} if cross else {}


def main():
    keys = sys.argv[1:] or list(MODELS)
    sess = sessions()
    summary = json.loads(OUT.read_text()) if OUT.exists() else {"models": {}}
    summary["models"] = {k: v for k, v in summary["models"].items() if k in MODELS}
    summary["data"] = {
        "sessions": len(sess),
        "speakers": sum(len({u[2] for u in utts}) for _, utts in sess),
        "utterances": sum(len(utts) for _, utts in sess),
        "clip_s": [MIN_S, MAX_S], "per_speaker_cap": PER_SPK, "margin": MARGIN,
    }
    for key in keys:
        embed, t0 = embedder(key), time.perf_counter()
        sess_embs, audio_s = [], 0.0
        for a, utts in sess:
            E = np.stack([embed(a[int(s * SR) : int(e * SR)]) for s, e, _ in utts])
            audio_s += sum(e - s for s, e, _ in utts)
            sess_embs.append((E, np.array([k for *_, k in utts])))
        rtf = (time.perf_counter() - t0) / audio_s
        d, f, lic = MODELS[key]
        r = {"url": RELEASE + f, "local_dir": f"models/{d}", "license": lic, "runtime": "onnxruntime + kaldi-native-fbank (tractus.voices)",
             "rtf_cpu2": round(rtf, 4), "pairs": pair_trials(sess_embs),
             "production": production(sess, sess_embs, {}),  # 정답 = AI Hub 라벨 (기본, 보수적)
             "production_alias": production(sess, sess_embs, ALIASES),  # 민감도: ALIASES를 같은 사람으로 (미검증)
             "cross_session": cross_session(sess, sess_embs)}
        summary["models"][key] = r
        print(json.dumps({"model": key, "rtf": r["rtf_cpu2"], "pairs_same_session": r["pairs"]["same_session"],
                          "production": r["production"]["trials"]}, ensure_ascii=False))
        OUT.write_text(json.dumps(summary, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps(summary["data"]))


if __name__ == "__main__":
    main()
