"""언어 고정 루프 재시도의 자주 쓰는 단어 A/B (asr.py `_transcribe`, 2026-11-25). 가상 음성(macOS say)만 쓴다.

언어를 고정한 첫 변환이 루프(토큰 상한)에 걸리면 자동 감지로 한 번 더 돈다. 옛 코드는 이 재시도에 받은 단어 전부를 넣었고
(상한 50개·1초 미만 청크·받아 적기 규칙을 건너뜀), 고친 코드는 다른 재시도처럼 규칙을 거친 단어를 넣는다.
루프를 일부러 부르려고 말과 다른 언어로 고정한다(영어 음성 → ko, 한국어 음성 → en, Phase 0). 사전은 대본 용어 뒤에
대본에 없는 단어를 붙여 HOTWORDS_MAX를 넘긴다(큰 사용자 사전). 한 번 올린 모델로 두 갈래를 다 돈다:
after는 제품 그대로, before는 그 재시도 호출의 단어만 전체 목록으로 바꾼다.
가상 음성으로는 루프가 거의 안 나서(2026-11-25 첫 실행: 두 모델 모두 22개 중 0개) `forced`는 첫 호출을 루프 출력으로
바꿔 모든 클립이 재시도를 타게 한다: 재시도 하나의 결과를 단어 전부 대 규칙을 거친 단어로 맞대는 것이다.

    uv run python hotword_retry_ab.py qwen3-0.6b qwen3-1.7b   → results/hotword_retry_ab.json (지표만)
"""

import json
import subprocess
from types import SimpleNamespace
import sys
import tempfile
from collections import Counter
from pathlib import Path

import numpy as np
import soundfile as sf

import score
from asr import MODELS, MODELS_DIR
from tractus import asr as product
from tractus.asr import SR, has_loop

CACHE = Path(__file__).resolve().parent / "cache" / "hotword_ab"
OUT = Path(__file__).resolve().parent / "results" / "hotword_retry_ab.json"

# (음성, 대본, 대본의 용어). 가상 회의 문장이다.
CLIPS = [
    ("Samantha", "We moved the Kubernetes cluster to the new region last week. The Terraform plan still shows drift on two load balancers, so Priya will rerun it on Monday.", ["Kubernetes", "Terraform", "Priya"]),
    ("Samantha", "The Grafana dashboard shows p95 latency above three hundred milliseconds. Let's add a Prometheus alert before the Atlas launch.", ["Grafana", "p95", "Prometheus", "Atlas"]),
    ("Samantha", "Our Snowflake bill doubled in October. Marcus thinks the dbt models are rebuilding every hour instead of once a day.", ["Snowflake", "Marcus", "dbt"]),
    ("Samantha", "Please file a Jira ticket for the OAuth redirect bug. It only happens in Safari when the session cookie has expired.", ["Jira", "OAuth", "Safari"]),
    ("Samantha", "The Figma mockups for onboarding are ready. Hannah wants feedback by Thursday so engineering can start the React components.", ["Figma", "Hannah", "React"]),
    ("Samantha", "We should replace the Redis cache with Memcached only if the benchmark shows a real gain. Otherwise keep it simple.", ["Redis", "Memcached"]),
    ("Samantha", "The Stripe webhook failed three times overnight. Daniel added retries, but we still need an idempotency key on the Postgres side.", ["Stripe", "Daniel", "Postgres"]),
    ("Samantha", "Next quarter the Orion team will migrate from Jenkins to GitHub Actions. The pilot starts with the billing service.", ["Orion", "Jenkins", "GitHub Actions"]),
    ("Daniel", "Sofia asked whether the Kafka consumers can keep up during the Black Friday peak. We plan a load test with Locust next Tuesday.", ["Sofia", "Kafka", "Locust"]),
    ("Daniel", "The Datadog trial ends on Friday. If we keep it, the Sentry integration has to move to the same account.", ["Datadog", "Sentry"]),
    ("Karen", "The TypeScript migration is about seventy percent done. The remaining files are in the legacy webpack config and the Electron shell.", ["TypeScript", "webpack", "Electron"]),
    ("Karen", "Leo will present the Nimbus roadmap at the all hands. Keep the slides short and put the Okta rollout on the last page.", ["Leo", "Nimbus", "Okta"]),
    ("Yuna", "지난주에 Kubernetes 클러스터를 새 리전으로 옮겼습니다. Terraform 계획에 아직 차이가 두 군데 남아 있어서 Priya가 월요일에 다시 돌립니다.", ["Kubernetes", "Terraform", "Priya"]),
    ("Yuna", "Grafana 화면을 보면 p95 지연이 300밀리초를 넘습니다. Atlas 출시 전에 Prometheus 경보를 하나 더 걸어 둡시다.", ["Grafana", "p95", "Atlas", "Prometheus"]),
    ("Yuna", "10월 Snowflake 요금이 두 배가 됐습니다. Marcus는 dbt 모델이 하루 한 번이 아니라 매시간 다시 만들어진다고 봅니다.", ["Snowflake", "Marcus", "dbt"]),
    ("Yuna", "OAuth 주소 이동 버그는 Jira에 올려 주세요. 세션 쿠키가 만료됐을 때 Safari에서만 생깁니다.", ["OAuth", "Jira", "Safari"]),
    ("Yuna", "온보딩 Figma 시안이 나왔습니다. Hannah가 목요일까지 의견을 받고 싶어 해서 그 뒤에 React 작업을 시작합니다.", ["Figma", "Hannah", "React"]),
    ("Yuna", "Stripe 웹훅이 밤사이 세 번 실패했습니다. Daniel이 재시도를 넣었지만 Postgres 쪽에 중복 방지 키가 필요합니다.", ["Stripe", "Daniel", "Postgres"]),
    ("Yuna", "다음 분기에 Orion 팀이 Jenkins에서 GitHub Actions로 옮깁니다. 시범은 결제 서비스부터 합니다.", ["Orion", "Jenkins", "GitHub Actions"]),
    ("Yuna", "Sofia가 블랙 프라이데이 때 Kafka 소비자가 버틸 수 있는지 물었습니다. 다음 주 화요일에 Locust로 부하 시험을 합니다.", ["Sofia", "Kafka", "Locust"]),
    ("Yuna", "Datadog 체험판이 금요일에 끝납니다. 계속 쓰면 Sentry 연동도 같은 계정으로 옮겨야 합니다.", ["Datadog", "Sentry"]),
    ("Yuna", "Leo가 전체 회의에서 Nimbus 로드맵을 발표합니다. 화면은 짧게 하고 Okta 도입은 마지막 장에 넣어 주세요.", ["Leo", "Nimbus", "Okta"]),
]

# 대본에 없는 사전 단어 (큰 사용자 사전을 흉내 낸다). 대본 용어 뒤에 붙인다.
PAD = [
    "Ansible", "Bitbucket", "Cassandra", "Confluence", "Databricks", "Elasticsearch", "Fastly", "Gitea", "Helm", "Istio",
    "Jupyter", "Kibana", "Linkerd", "MongoDB", "Nginx", "OpenSearch", "Pulumi", "RabbitMQ", "SonarQube", "Tableau",
    "Vault", "Zabbix", "Airflow", "BigQuery", "CircleCI", "Dynatrace", "Envoy", "Flink", "Gradle", "Hadoop",
    "Keycloak", "Lambda", "Mixpanel", "Nagios", "Opsgenie", "PagerDuty", "Qdrant", "Rancher", "Splunk", "Traefik",
    "Unity", "Vercel", "Weaviate", "Zookeeper", "Amplitude", "Buildkite", "Cloudflare", "Docusign", "Expo", "Firebase",
    "김지훈", "이서연", "박민준", "최유진", "정하늘", "강도윤", "조은비", "윤서준", "장예린", "임태현",
    "프로젝트 해오름", "새벽별 TF", "누리 플랫폼", "가람 시스템", "한빛 포털", "다온 앱", "온새미 서비스", "라온 허브", "미르 엔진", "비나리 봇",
]

LANG_FOR = {"Yuna": "en"}  # 말과 다른 언어로 고정한다 (나머지 영어 음성은 ko)


def clip_audio(i: int, voice: str, text: str) -> np.ndarray:
    wav = CACHE / f"{i:02d}.wav"
    if not wav.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            aiff = Path(tmp) / "a.aiff"
            subprocess.run(["say", "-v", voice, "-o", str(aiff), text], check=True)
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(aiff), "-ac", "1", "-ar", str(SR), str(wav)], check=True)
    a, sr = sf.read(wav, dtype="float32")
    assert sr == SR
    return a


def run(model, glossary: list[str], forced: bool) -> dict:
    real, state = model._generate, {}

    def gen(audio, language, hotwords, max_tokens, temperature=0.0):
        state["calls"].append(language)
        if forced and len(state["calls"]) == 1:  # 언어 고정 첫 변환이 루프에 걸린 것으로 친다
            return SimpleNamespace(text="조사를 하며 " * 20, language=None, generation_tokens=max_tokens)
        if state["before"] and state["calls"][0] is not None and language is None and temperature == 0:
            hotwords = glossary  # 옛 코드: 언어 고정 루프 재시도에 받은 단어 전부
        return real(audio, language, hotwords, max_tokens, temperature)

    model._generate = gen
    rows = {"before": [], "after": []}
    retried = Counter()
    for i, (voice, text, terms) in enumerate(CLIPS):
        audio = clip_audio(i, voice, text)
        for arm in ("before", "after"):
            state.update(before=arm == "before", calls=[])
            seg = model.transcribe(audio, LANG_FOR.get(voice, "ko"), glossary)
            retried[arm] += None in state["calls"][1:]
            rows[arm].append({"ref": text, "hyp": seg.text, "meta": {"glossary": terms}})
    out = {}
    for arm, rs in rows.items():
        out[arm] = {
            "cer": round(score.cer([r["ref"] for r in rs], [r["hyp"] for r in rs]), 2),
            "term_recall": round(score.term_recall(rs), 1),
            "auto_retries": retried[arm],
            "loops_left": sum(has_loop(r["hyp"]) for r in rs),
        }
    out["differ"] = sum(a["hyp"] != b["hyp"] for a, b in zip(rows["before"], rows["after"]))
    model._generate = real
    return out


def main():
    terms = list(dict.fromkeys(t for _, _, ts in CLIPS for t in ts))
    glossary = terms + [p for p in PAD if p not in terms]
    assert len(terms) <= product.HOTWORDS_MAX < len(glossary)
    result = {"clips": len(CLIPS), "glossary": len(glossary), "terms": len(terms), "hotwords_max": product.HOTWORDS_MAX, "models": {}}
    for name in sys.argv[1:]:
        model = product.Transcriber.load(MODELS_DIR / MODELS[name][0])
        result["models"][name] = {mode: run(model, glossary, mode == "forced") for mode in ("natural", "forced")}
        print(name, json.dumps(result["models"][name], ensure_ascii=False), flush=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
