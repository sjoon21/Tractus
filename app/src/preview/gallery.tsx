// 부품 갤러리 (개발 서버 전용, `pnpm dev` → /gallery.html). 앱 화면 없이 src/components/ui의 부품과 공용 클래스를 한 페이지에 모아 라이트·다크로 점검한다.
// 빌드(index.html)에는 들어가지 않는다. 새 부품을 만들면 여기에 한 줄 더한다 (app/DESIGN.md).
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "../theme.css";
import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Check, Mic, Play, Sparkles, TextSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dock, DockGroup } from "@/components/ui/dock";
import { DIALOG, DIALOG_BODY, DIALOG_FOOTER, DIALOG_TEXT, DIALOG_TITLE, DIALOG_WARN } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Progress } from "@/components/ui/progress";
import { Empty } from "@/components/ui/empty";
import { Row, Section } from "@/components/ui/section";
import { Select } from "@/components/ui/select";
import { Switch, checkClass } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MENU, MENU_ITEM } from "@/components/menu";
import { resolveTheme, type ThemePref } from "../themePref"; // applyTheme은 Tauri 창 API를 불러 브라우저에서 못 쓴다: data-theme만 직접 정한다
import { cn } from "@/components/ui/utils";
import { CallCardView, MiniRecorderView } from "../MiniRecorder";
import { EMPTY_POPOVER, type PopoverState } from "../TrayPopover";
import type { MeetingInfo } from "../api";
import { OK } from "../caps";
import { EventRow } from "../components/home/WeekStrip";
import type { DayEvent } from "../week";
import { NoteRow } from "../NoteRow";
import { setSwiped } from "../noteSwipe";
import { deleteDialogText } from "../remove";

const SWIPE_NOTE: MeetingInfo = { id: "gallery-swipe", dir: "/Users/me/Tractus/meetings/2026-11-16_주간_동기화_01ABC", title: "주간 제품 동기화", created_at: "2026-11-16T10:00:00+09:00", duration_sec: 1820, segments: 120, has_summary: true, tags: ["제품"] };
const DELETE_TEXT = deleteDialogText({ kind: "note", id: SWIPE_NOTE.id, title: SWIPE_NOTE.title, dir: SWIPE_NOTE.dir });

const applyTheme = (p: ThemePref) => void (document.documentElement.dataset.theme = resolveTheme(p, matchMedia("(prefers-color-scheme: dark)").matches));

const VARIANTS = ["default", "outline", "secondary", "ghost", "destructive", "rec", "link"] as const;
const SIZES = ["sm", "default", "lg"] as const;
const COLORS = ["background", "foreground", "card", "popover", "primary", "secondary", "muted", "accent", "border", "border-strong", "input", "ring", "destructive", "rec", "rec-wash", "memo", "memo-wash", "sidebar", "sidebar-accent"];
const TEXTS: [string, string][] = [
  ["노트 제목", "text-[22px] font-semibold tracking-tight"],
  ["화면 머리 (PageHeader)", "text-[15px] font-semibold"],
  ["구역 제목 / 기본 UI 글자", "text-[13px] font-semibold"],
  ["읽는 글 (대화 내용·메모)", "text-[15px] leading-7"],
  ["오른쪽 패널 읽는 글", "text-[14px] leading-6"],
  ["보조·메타·설명", "text-xs text-muted-foreground"],
  ["배지·단축키", "text-[11px]"],
];

// 이번 주 일정 줄의 네 상태 (지금 = 11월 17일 9:00)
const ROW_NOW = new Date(2026, 10, 17, 9, 0);
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
const rowEvent = (id: string, title: string, d: number, h: number, notes: MeetingInfo[] = []): DayEvent => ({ id, title, start: at(d, h), end: at(d, h + 1), calendar: "회사", attendees: ["김민수", "이지은"], notes });
const rowNote = (id: string, title: string, ev: { id: string; title: string; start: string }, kind?: "memo"): MeetingInfo => ({ id, dir: "", title, created_at: "2026-11-16T18:00:00+09:00", duration_sec: kind ? 0 : 1800, segments: 0, has_summary: false, kind, event: ev });
const ROWS: DayEvent[] = [
  rowEvent("g1", "오늘 · 준비한 메모 없음 (메모 준비 + 녹음)", 17, 10),
  rowEvent("g2", "오늘 · 준비한 메모 있음 (녹음은 그 노트에)", 17, 14),
  rowEvent("g3", "오늘 · 녹음 노트만 있음 (새 노트로 녹음)", 17, 16),
  rowEvent("g4", "내일 · 메모 준비만", 18, 11),
].map((ev) => ({ ...ev, notes: ev.id === "g2" ? [rowNote("n2", "주간 점검 메모", ev, "memo")] : ev.id === "g3" ? [rowNote("n3", "주간 점검", ev)] : [] }));

const MINI_REC: PopoverState ={ ...EMPTY_POPOVER, phase: "recording", started_at_ms: 1_000_000, can: { start: false, pause: true, resume: false, stop: true, bookmark: true } };

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-border pb-8">
      <div>
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {note && <p className="m-0 mt-0.5 text-xs text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  );
}

const Cell = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col items-start gap-1.5">
    <span className="text-[11px] text-subtle-foreground">{label}</span>
    {children}
  </div>
);

function Gallery() {
  const [theme, setTheme] = useState<ThemePref>("system");
  const [tab, setTab] = useState("요약");
  const pick = (p: ThemePref) => {
    setTheme(p);
    applyTheme(p);
  };
  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-8 px-6 py-8 text-[13px]">
      <header className="sticky top-0 z-20 -mx-6 flex items-center gap-3 border-b border-border bg-background/90 px-6 py-3 backdrop-blur-md">
        <h1 className="m-0 mr-auto text-[17px] font-semibold">부품 갤러리</h1>
        {(["system", "light", "dark"] as const).map((p) => (
          <Button key={p} size="sm" variant={theme === p ? "default" : "outline"} onClick={() => pick(p)}>
            {{ system: "시스템", light: "라이트", dark: "다크" }[p]}
          </Button>
        ))}
      </header>

      <Block title="색" note="theme.css 토큰. 색은 의미로만 쓴다 (DESIGN.md §1)">
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}>
          {COLORS.map((c) => (
            <div key={c} className="overflow-hidden rounded-md border border-border">
              <div className="h-9" style={{ background: `var(--${c})` }} />
              <div className="px-2 py-1 text-[11px] text-muted-foreground">{c}</div>
            </div>
          ))}
        </div>
      </Block>

      <Block title="글자 크기" note="DESIGN.md §2">
        <div className="flex flex-col gap-2">
          {TEXTS.map(([label, cls]) => (
            <div key={label} className="flex items-baseline gap-4">
              <span className="w-48 shrink-0 text-[11px] text-subtle-foreground">{label}</span>
              <span className={cls}>회의 내용을 텍스트로 변환합니다 Aa 123</span>
            </div>
          ))}
        </div>
      </Block>

      <Block title="Button" note="variant × size. default는 그 화면의 주 동작 하나만">
        {SIZES.map((size) => (
          <div key={size} className="flex flex-wrap items-center gap-2">
            <span className="w-14 text-[11px] text-subtle-foreground">{size}</span>
            {VARIANTS.map((v) => (
              <Button key={v} variant={v} size={size}>
                {v}
              </Button>
            ))}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-14 text-[11px] text-subtle-foreground">아이콘</span>
          <Button size="icon" variant="outline" aria-label="재생"><Play /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="찾기"><TextSearch /></Button>
          <Button><Mic aria-hidden />아이콘 + 글자</Button>
          <Button variant="outline" disabled>꺼짐</Button>
        </div>
      </Block>

      <Block title="Badge · Kbd · Progress">
        <div className="flex flex-wrap items-center gap-3">
          <Badge>default</Badge>
          <Badge variant="memo">memo</Badge>
          <Badge variant="rec">rec</Badge>
          <Badge variant="outline">outline</Badge>
          <Kbd>⌘K</Kbd>
          <Kbd>⌥⌘B</Kbd>
        </div>
        <div className="flex max-w-sm flex-col gap-3">
          <Progress value={0.35} />
          <Progress value={null} />
        </div>
      </Block>

      <Block title="Empty" note="빈 상태: 제목 한 줄 + 짧은 설명 + 단추 하나까지 (상자·아이콘 칩 없음)">
        <Empty className="max-w-sm" title="아직 요약이 없습니다" action={<Button size="sm">요약 만들기</Button>}>
          위에서 요약 유형을 고르고 ‘요약 만들기’를 누르면 근거 대화와 함께 정리합니다.
        </Empty>
      </Block>

      <Block title="입력" note="Input · Textarea · Select · Switch · 체크박스·라디오">
        <div className="grid max-w-xl grid-cols-2 gap-4">
          <Cell label="Input"><Input className="max-w-sm" placeholder="노트 검색" /></Cell>
          <Cell label="Select">
            <Select className="max-w-sm" defaultValue="a">
              <option value="a">매번 묻기</option>
              <option value="b">바로 변환</option>
            </Select>
          </Cell>
          <Cell label="Switch">
            <div className="flex items-center gap-3"><Switch defaultChecked aria-label="켬" /><Switch aria-label="끔" /></div>
          </Cell>
          <Cell label="체크박스 · 라디오">
            <div className="flex items-center gap-3"><input type="checkbox" className={checkClass} defaultChecked /><input type="radio" className={checkClass} defaultChecked /></div>
          </Cell>
          <div className="col-span-2"><Cell label="Textarea"><Textarea className="max-w-md" rows={2} placeholder="메모를 쓰세요" /></Cell></div>
        </div>
      </Block>

      <Block title="Section + Row" note="설정처럼 이름/조작이 짝인 목록">
        <Section title="녹음" description="구역 제목과 설명">
          <Row label="녹음을 끝내면" hint="나중에 변환하면 ‘변환 전’ 노트로 저장됩니다" control={<Select defaultValue="a"><option value="a">매번 묻기</option></Select>} />
          <Row label="실시간 텍스트 변환" hint="말하는 동안 미리 보여 줍니다" control={<Switch aria-label="실시간" />} />
        </Section>
      </Block>

      <Block title="Dock" note="가운데 화면 아래에 뜨는 도구 막대. 탭 · 도구 묶음을 구분선으로 나눈다">
        <div className="rounded-lg border border-border bg-background">
          <Dock label="도구 막대">
            <DockGroup>
              <div role="tablist" className="flex gap-0.5">
                {["요약", "회의록", "AI 질문", "메모"].map((k) => (
                  <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="h-7 whitespace-nowrap rounded-full px-3 text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground aria-selected:bg-accent aria-selected:text-foreground">
                    {k}
                  </button>
                ))}
              </div>
            </DockGroup>
            <DockGroup>
              <Button variant="ghost" size="sm"><Sparkles aria-hidden />스마트 교정</Button>
            </DockGroup>
            <DockGroup>
              <Button variant="ghost" size="icon-sm" aria-label="찾기"><TextSearch /></Button>
            </DockGroup>
          </Dock>
        </div>
      </Block>

      <Block title="메뉴 (MENU · MENU_ITEM)" note="Popover/ItemMenu가 쓰는 클래스. 위험한 항목은 빨강 글자">
        <div className={cn(MENU, "w-52")}>
          <button className={MENU_ITEM}><Check aria-hidden />선택한 항목</button>
          <button className={MENU_ITEM}>이름 바꾸기</button>
          <hr className="my-1 border-border" />
          <button className={cn(MENU_ITEM, "text-destructive")}>삭제…</button>
        </div>
      </Block>

      <Block title="녹음 미니 창 (MiniRecorderView)" note="녹음 중 Tractus 창을 보고 있지 않을 때 화면 구석에 뜬다 (mini.rs, 창 320×56)">
        <div className="flex flex-wrap gap-4">
          <div className="w-[320px] p-1.5">
            <MiniRecorderView state={MINI_REC} nowMs={MINI_REC.started_at_ms! + 754_000} level={0.7} onAction={() => {}} />
          </div>
          <div className="w-[320px] p-1.5">
            <MiniRecorderView state={{ ...MINI_REC, phase: "paused", elapsed_ms: 3_725_000, can: { ...MINI_REC.can, pause: false, resume: true } }} nowMs={0} level={0} onAction={() => {}} />
          </div>
          <div className="w-[320px] p-1.5">
            <CallCardView call={{ kind: "start", app: "Zoom", title: "주간 제품 동기화" }} onCall={() => {}} />
          </div>
          <div className="w-[320px] p-1.5">
            <CallCardView call={{ kind: "end", app: "Teams", title: "" }} onCall={() => {}} />
          </div>
        </div>
      </Block>

      <Block title="이번 주 일정 줄 (EventRow)" note="week.eventAction: 이어진 노트 없음 → 메모 준비(끝나지 않은 일정) · 준비한 메모 → 녹음은 그 노트에 추가 · 녹음 노트뿐 → 새 노트. 녹음 단추는 오늘 일정만">
        <ul className="m-0 list-none overflow-hidden rounded-lg border border-border bg-card p-0 py-1.5">
          {ROWS.map((ev) => (
            <EventRow key={ev.id} ev={ev} now={ROW_NOW} gate={OK} recording={false} onRecord={() => {}} onPrepare={() => {}} />
          ))}
        </ul>
      </Block>

      <Block title="노트 줄 밀어서 삭제 (NoteRow · noteSwipe)" note="트랙패드로 줄을 왼쪽으로 밀면 줄 끝에 삭제 단추. 바깥을 누르면 닫힌다 (아래 단추로 다시 연다)">
        <div className="flex items-start gap-4">
          <ul className="w-[260px] rounded-md bg-sidebar p-2">
            <NoteRow m={SWIPE_NOTE} active={false} onOpen={() => {}} onDelete={() => {}} />
            <NoteRow m={{ ...SWIPE_NOTE, id: "gallery-swipe-2", title: "하늘상사 인터뷰 메모", kind: "memo", tags: [] }} active={false} onOpen={() => {}} onDelete={() => {}} />
          </ul>
          <Button variant="outline" size="sm" onClick={() => setTimeout(() => setSwiped(SWIPE_NOTE.id), 0)}>삭제 단추 보이기</Button>
        </div>
      </Block>

      <Block title="삭제 확인 대화상자 (DIALOG_WARN)" note="노트 삭제 확인: 함께 사라지는 것을 위험 색으로 따로 알린다 (remove.deleteDialogText)">
        <div className={cn(DIALOG, "!m-0 !block")}>
          <div className={DIALOG_BODY}>
            <h2 className={DIALOG_TITLE}>{DELETE_TEXT.title}</h2>
            <p className={DIALOG_WARN}>{DELETE_TEXT.warning}</p>
            <p className={DIALOG_TEXT}>{DELETE_TEXT.body}</p>
          </div>
          <div className={DIALOG_FOOTER}>
            <Button variant="outline">{DELETE_TEXT.cancel}</Button>
            <Button variant="destructive">{DELETE_TEXT.confirm}</Button>
          </div>
        </div>
      </Block>

      <Block title="대화상자 (DIALOG)" note="네이티브 <dialog>의 공용 모양. 여기서는 열어 두지 않고 모양만 보인다">
        <div className={cn(DIALOG, "!m-0 !block")}>
          <div className={DIALOG_BODY}>
            <h2 className={DIALOG_TITLE}>새 버전이 나왔습니다: 0.5.4</h2>
            <p className={DIALOG_TEXT}>무엇이 바뀌었는지 확인해 보세요. 설정에서 ‘업데이트 설치’를 누를 때만 받아 설치합니다.</p>
          </div>
          <div className={DIALOG_FOOTER}>
            <Button variant="outline">나중에</Button>
            <Button>업데이트 보기</Button>
          </div>
        </div>
      </Block>
    </div>
  );
}

applyTheme("system");
setSwiped(SWIPE_NOTE.id); // 처음부터 밀어 둔 모양을 보인다
createRoot(document.getElementById("root")!).render(<Gallery />);
