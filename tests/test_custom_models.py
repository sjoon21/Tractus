"""직접 추가한 변환 엔진 (docs/design/asr-engines.md): `tractus models add <저장소>` → custom-models.json → 받기·고르기·지우기.
허브는 가짜다 (네트워크 없이 돈다)."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from tractus import cli
from tractus import models_install as inst
from tractus import models_registry as reg
from test_models import GB, root  # noqa: F401  (pytest fixture 재사용)


def fake_hub(monkeypatch, files: dict[str, int], config: dict, license: str | None = "mit", sha: str = "a" * 40):
    import huggingface_hub

    def model_info(self, repo, revision=None, files_metadata=False):
        return SimpleNamespace(sha=sha, siblings=[SimpleNamespace(rfilename=k, size=v) for k, v in files.items()], card_data={"license": license} if license else None)

    def hf_hub_download(repo, filename, revision=None, local_dir=None):
        p = Path(local_dir) / filename
        p.write_text(json.dumps(config))
        return str(p)

    monkeypatch.setattr(huggingface_hub.HfApi, "model_info", model_info)
    monkeypatch.setattr(huggingface_hub, "hf_hub_download", hf_hub_download)


WHISPER = {"config.json": 1500, "model.safetensors": 3_000_000, "tokenizer.json": 2000, "vocab.json": 800, "merges.txt": 500, "preprocessor_config.json": 300,
           "training_args.bin": 5000, "runs/events.out": 100, "flax_model.msgpack": 9000}


def test_add_registers_a_supported_engine_with_pinned_files(root, monkeypatch):
    fake_hub(monkeypatch, WHISPER, {"model_type": "whisper"})
    m = inst.add_custom("BuzzASR/korean", root)
    assert (m.id, m.engine, m.revision, m.license, m.local_dir) == ("custom-buzzasr-korean", "whisper", "a" * 40, "mit", "custom-buzzasr-korean")
    assert set(m.files) == {"config.json", "model.safetensors", "tokenizer.json", "vocab.json", "merges.txt", "preprocessor_config.json"}  # 학습 기록·.bin·하위 폴더는 받지 않는다
    assert m.size_bytes == sum(m.files.values()) and m.custom and m.needed_by == ("convert",)
    assert [x.id for x in reg.custom_models(root)] == [m.id]
    assert "custom-buzzasr-korean" in reg.asr_ids(root) and reg.get(m.id) == m and reg.resolve_ids([m.id], None) == [m.id]


def test_adding_the_same_repo_again_keeps_the_id_and_updates_the_revision(root, monkeypatch):
    fake_hub(monkeypatch, WHISPER, {"model_type": "whisper"})
    first = inst.add_custom("BuzzASR/korean", root)
    fake_hub(monkeypatch, WHISPER, {"model_type": "whisper"}, sha="b" * 40)
    again = inst.add_custom("BuzzASR/korean", root)
    assert again.id == first.id and again.revision == "b" * 40 and len(reg.custom_models(root)) == 1


@pytest.mark.parametrize("files,config,code", [
    ({"config.json": 1, "pytorch_model.bin": 9}, {"model_type": "whisper"}, "unsupported_model"),  # safetensors가 없다
    ({"config.json": 1, "model.safetensors": 9}, {"model_type": "wav2vec2"}, "unsupported_engine"),
    ({"config.json": 1, "weights.npz": 9}, {"model_type": "whisper"}, "unsupported_model"),  # 토크나이저가 없다 (실측 mlx-community/whisper-tiny)
])
def test_unsupported_models_are_refused(root, monkeypatch, files, config, code):
    fake_hub(monkeypatch, files, config)
    with pytest.raises(inst.ModelError) as e:
        inst.add_custom("someone/model", root)
    assert e.value.code == code and reg.custom_models(root) == ()


def test_bad_repo_ids_never_reach_the_hub(root):
    for bad in ("no-slash", "a/b/c", "../x", "a/ b", ""):
        with pytest.raises(inst.ModelError) as e:
            inst.add_custom(bad, root)
        assert e.value.code == "bad_repo"


def _install(m: reg.Model, root: Path) -> None:
    d = root / m.local_dir
    d.mkdir()
    for name, size in m.files.items():
        (d / name).write_bytes(b"0" * size)


def test_an_installed_custom_engine_counts_for_convert_and_is_not_pruned(root, monkeypatch):
    fake_hub(monkeypatch, WHISPER, {"model_type": "whisper"})
    m = inst.add_custom("BuzzASR/korean", root)
    _install(m, root)
    vad = reg.get("vad")
    _install(vad, root)
    states = {x.id: reg.inspect(x.id, root).state for x in reg.all_models(root)}
    convert = next(c for c in reg.capability_status(states, {"ffmpeg": True}, 16 * GB) if c["id"] == "convert")
    assert convert["ready"]
    assert inst.unregistered(root) == []  # 직접 추가한 폴더를 옛 모델로 보지 않는다
    monkeypatch.setattr(cli, "_warn", lambda code, message: None)
    assert cli.choose_asr(None, m.id).id == m.id and cli.track_name(m) == m.id
    assert cli.local_model(m.repo) == root / m.local_dir


def test_remove_deletes_the_files_and_the_entry(root, monkeypatch):
    fake_hub(monkeypatch, WHISPER, {"model_type": "whisper"})
    m = inst.add_custom("BuzzASR/korean", root)
    _install(m, root)
    out = inst.remove(m.id, root)
    assert out["removed"] and not (root / m.local_dir).exists() and reg.custom_models(root) == ()
    m2 = inst.add_custom("BuzzASR/korean", root)  # 받지 않은 채 지워도 목록에서 빠진다
    assert inst.remove(m2.id, root)["removed"] and reg.custom_models(root) == ()


def test_a_broken_entry_is_skipped_not_fatal(root):
    (root / reg.CUSTOM_FILE).write_text(json.dumps({"models": [{"id": "custom-x", "repo": "a/b"}, "junk",
                                                               {"id": "custom-ok", "repo": "a/c", "revision": "r", "engine": "whisper", "files": {"config.json": 1}},
                                                               {"id": "custom-evil", "repo": "a/d", "revision": "r", "engine": "whisper", "files": {"../x": 1}}]}))
    assert [m.id for m in reg.custom_models(root)] == ["custom-ok"]


def test_move_takes_the_custom_list_along(root, monkeypatch, tmp_path):
    fake_hub(monkeypatch, WHISPER, {"model_type": "whisper"})
    m = inst.add_custom("BuzzASR/korean", root)
    _install(m, root)
    _install(reg.get("vad"), root)
    dest = tmp_path / "elsewhere"
    dest.mkdir()
    out = inst.move(root, dest)
    assert m.id in out["moved"] and [x.id for x in reg.custom_models(dest)] == [m.id] and not (root / reg.CUSTOM_FILE).exists()


def test_models_add_cli_prints_the_entry(root, monkeypatch):
    from typer.testing import CliRunner

    fake_hub(monkeypatch, WHISPER, {"model_type": "whisper"})
    r = CliRunner().invoke(cli.app, ["models", "add", "BuzzASR/korean"])
    assert r.exit_code == 0, r.output
    assert json.loads(r.stdout.strip().splitlines()[-1]) == {"id": "custom-buzzasr-korean", "repo": "BuzzASR/korean", "revision": "a" * 40,
                                                             "engine": "whisper", "size_bytes": sum(v for k, v in WHISPER.items() if k in ("config.json", "model.safetensors", "tokenizer.json", "vocab.json", "merges.txt", "preprocessor_config.json")), "license": "mit"}
    listed = json.loads(CliRunner().invoke(cli.app, ["models", "list", "--json"]).stdout)
    row = next(x for x in listed["models"] if x["id"] == "custom-buzzasr-korean")
    assert (row["custom"], row["engine"], row["state"], row["needed_by"]) == (True, "whisper", "missing", ["convert"])
