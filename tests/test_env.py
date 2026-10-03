from tractus.env import load_env


def test_shell_beats_local_beats_env(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("A=from_env\nB=from_env\nC=from_env\n")
    (tmp_path / ".env.local").write_text("B=from_local\nC=from_local\n")
    monkeypatch.setenv("C", "from_shell")
    for k in ("A", "B"):
        monkeypatch.delenv(k, raising=False)
    load_env(tmp_path)
    import os

    assert (os.environ["A"], os.environ["B"], os.environ["C"]) == ("from_env", "from_local", "from_shell")


def test_parses_comments_quotes_and_export(tmp_path, monkeypatch):
    (tmp_path / ".env.local").write_text(
        "# 주석\n\nexport KEY1=plain\nKEY2=\"quoted value\"\nKEY3='single'\nKEY4=a=b # 뒤 주석\nKEY5=\nKEY6=      # 값 없이 주석만\n잘못된 줄\n"
    )
    for k in ("KEY1", "KEY2", "KEY3", "KEY4", "KEY5", "KEY6"):
        monkeypatch.delenv(k, raising=False)
    load_env(tmp_path)
    import os

    assert [os.environ.get(k) for k in ("KEY1", "KEY2", "KEY3", "KEY4", "KEY5", "KEY6")] == ["plain", "quoted value", "single", "a=b", None, None]


def test_empty_local_value_does_not_shadow_env(tmp_path, monkeypatch):
    (tmp_path / ".env.local").write_text("TRACTUS_X=\n")
    (tmp_path / ".env").write_text("TRACTUS_X=from_env\n")
    monkeypatch.delenv("TRACTUS_X", raising=False)
    load_env(tmp_path)
    import os

    assert os.environ["TRACTUS_X"] == "from_env"


def test_missing_files_are_fine(tmp_path):
    load_env(tmp_path)


def test_empty_shell_value_does_not_block_file_value(tmp_path, monkeypatch):
    (tmp_path / ".env.local").write_text("TRACTUS_Y=from_local\n")
    monkeypatch.setenv("TRACTUS_Y", "")
    load_env(tmp_path)
    import os

    assert os.environ["TRACTUS_Y"] == "from_local"


def test_home_env_is_read_after_cwd(tmp_path, monkeypatch):
    from tractus.env import load_env_all

    cwd, home = tmp_path / "cwd", tmp_path / "home"
    cwd.mkdir(), home.mkdir()
    (cwd / ".env").write_text("TRACTUS_Z=from_cwd\n")
    (home / ".env.local").write_text("TRACTUS_Z=from_home\nTRACTUS_W=only_home\n")
    monkeypatch.chdir(cwd)
    monkeypatch.setenv("TRACTUS_HOME", str(home))
    for k in ("TRACTUS_Z", "TRACTUS_W"):
        monkeypatch.delenv(k, raising=False)
    load_env_all()
    import os

    assert (os.environ["TRACTUS_Z"], os.environ["TRACTUS_W"]) == ("from_cwd", "only_home")
