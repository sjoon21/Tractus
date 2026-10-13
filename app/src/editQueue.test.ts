import { describe, expect, test } from "vitest";
import { EditQueue } from "./editQueue";

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

describe("EditQueue", () => {
  test("한 노트의 작업은 들어온 순서대로 하나씩 돈다", async () => {
    const q = new EditQueue();
    const log: string[] = [];
    const g = gate();
    const a = q.run("n1", async () => {
      log.push("a:start");
      await g.p;
      log.push("a:end");
    });
    const b = q.run("n1", async () => void log.push("b"));
    await Promise.resolve();
    expect(log).toEqual(["a:start"]); // b는 a가 끝나길 기다린다
    g.open();
    await Promise.all([a, b]);
    expect(log).toEqual(["a:start", "a:end", "b"]);
  });

  test("앞 작업이 실패해도 다음 작업은 돈다", async () => {
    const q = new EditQueue();
    const a = q.run("n1", async () => Promise.reject(new Error("저장 실패")));
    const b = q.run("n1", async () => "ok");
    await expect(a).rejects.toThrow("저장 실패");
    await expect(b).resolves.toBe("ok");
  });

  test("노트마다 줄이 따로다", async () => {
    const q = new EditQueue();
    const g = gate();
    const slow = q.run("n1", () => g.p);
    expect(await q.run("n2", async () => "다른 노트")).toBe("다른 노트");
    g.open();
    await slow;
  });

  test("삭제: 줄이 빌 때까지 기다린 뒤 실행하고, 그동안 새 수정은 받지 않는다", async () => {
    const q = new EditQueue();
    const log: string[] = [];
    const g = gate();
    const edit = q.run("n1", async () => {
      await g.p;
      log.push("edit");
    });
    const del = q.exclusive("n1", async () => void log.push("delete"));
    expect(q.isBlocked("n1")).toBe(true);
    let ran = false;
    expect(await q.run("n1", async () => void (ran = true))).toBeUndefined(); // 막힌 뒤의 수정은 돌지 않는다
    expect(ran).toBe(false);
    await Promise.resolve();
    expect(log).toEqual([]); // 저장 중인 수정이 끝나기 전에는 삭제가 시작하지 않는다
    g.open();
    await Promise.all([edit, del]);
    expect(log).toEqual(["edit", "delete"]);
    expect(q.isBlocked("n1")).toBe(false);
    expect(await q.run("n1", async () => "다시 열림")).toBe("다시 열림");
  });

  test("삭제가 실패해도 다시 열린다", async () => {
    const q = new EditQueue();
    await expect(q.exclusive("n1", async () => Promise.reject(new Error("처리 중")))).rejects.toThrow("처리 중");
    expect(q.isBlocked("n1")).toBe(false);
  });

  test("저장이 실패한 줄도 삭제를 막지 않는다", async () => {
    const q = new EditQueue();
    const bad = q.run("n1", async () => Promise.reject(new Error("x")));
    bad.catch(() => {});
    await expect(q.exclusive("n1", async () => "deleted")).resolves.toBe("deleted");
  });

  test("줄이 없는 노트의 drain은 바로 끝난다", async () => {
    await expect(new EditQueue().drain("none")).resolves.toBeUndefined();
  });
});
