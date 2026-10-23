from pathlib import Path

from tractus import prompts

DIR = Path(prompts.__file__).parent


def test_every_prompt_file_loads_with_no_empty_or_unfilled_block():
    files = sorted(p.stem for p in DIR.glob("*.md"))
    assert {"ask", "common", "enhance", "minutes", "polish", "summaries", "summarize"} <= set(files)
    for name in files:
        blocks = prompts.load(name)
        assert blocks, name
        for key, text in blocks.items():
            assert text.strip() and "{{" not in text, (name, key)
            assert text == text.strip("\n"), (name, key)


def test_block_reference_is_replaced_by_the_block_of_the_same_file():
    blocks = prompts.load("summarize")
    assert blocks["lang"] in blocks["system"]
