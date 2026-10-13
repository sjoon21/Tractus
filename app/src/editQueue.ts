// 노트마다 하나의 저장 줄. 문장 수정·참석자 편집·목소리 등록·내보내기가 같은 줄에 선다:
// 코어가 transcript.json을 읽고-고쳐-쓰므로 한 노트에 둘이 동시에 돌면 안 된다.
// 줄은 모듈에 둔다(화면이 아니라): 노트를 닫았다 열어도 저장 중인 작업은 계속 줄에 서 있고, 삭제는 줄이 빌 때까지 기다린다.

interface Line {
  chain: Promise<unknown>;
  blocked: boolean;
}

export class EditQueue {
  private lines = new Map<string, Line>();

  private line(id: string): Line {
    let l = this.lines.get(id);
    if (!l) this.lines.set(id, (l = { chain: Promise.resolve(), blocked: false }));
    return l;
  }

  /** 삭제를 기다리는 중이라 새 작업을 받지 않는다 */
  isBlocked(id: string): boolean {
    return this.lines.get(id)?.blocked ?? false;
  }

  /** 줄에 세운다. 앞 작업이 실패해도 이어서 돈다. 막혀 있으면 아무것도 하지 않고 undefined로 끝난다 */
  run<T>(id: string, task: () => Promise<T>): Promise<T | undefined> {
    const l = this.line(id);
    if (l.blocked) return Promise.resolve(undefined);
    const run = l.chain.then(task);
    l.chain = run.catch(() => {});
    return run;
  }

  /** 지금 줄에 선 작업이 모두 끝나면 풀린다 (실패해도 풀린다) */
  drain(id: string): Promise<void> {
    return (this.lines.get(id)?.chain ?? Promise.resolve()).then(() => {});
  }

  /** 막는다: 이미 선 작업은 끝까지 돌고, 그 뒤에 오는 작업은 받지 않는다 */
  block(id: string): void {
    this.line(id).blocked = true;
  }

  unblock(id: string): void {
    const l = this.lines.get(id);
    if (l) l.blocked = false;
  }

  /**
   * 노트를 지우기 전: 막고 줄을 비운 뒤 `action`을 돌린다. 끝나면(성공·실패) 다시 연다.
   * 줄이 비는 동안 새 수정은 받지 않으므로, `action`이 도는 중에는 이 노트에 아무 쓰기도 없다
   */
  async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.block(id);
    try {
      await this.drain(id);
      return await action();
    } finally {
      this.unblock(id);
    }
  }
}

/** 앱 전체가 같이 쓰는 줄 */
export const editQueue = new EditQueue();
