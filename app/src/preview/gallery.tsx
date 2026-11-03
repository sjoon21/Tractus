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
import { DIALOG, DIALOG_BODY, DIALOG_FOOTER, DIALOG_TEXT, DIALOG_TITLE } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Progress } from "@/components/ui/progress";
import { Row, Section } from "@/components/ui/section";
import { Select } from "@/components/ui/select";
import { Switch, checkClass } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MENU, MENU_ITEM } from "@/components/menu";
import { resolveTheme, type ThemePref } from "../themePref"; // applyTheme은 Tauri 창 API를 불러 브라우저에서 못 쓴다: data-theme만 직접 정한다
import { cn } from "@/components/ui/utils";

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
createRoot(document.getElementById("root")!).render(<Gallery />);
