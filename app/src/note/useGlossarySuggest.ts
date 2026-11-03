// 고친 낱말을 자주 쓰는 단어로 제안한다 (vocab.ts). 여러 개면 한 알림으로 묻고, 한 번 물은 낱말은 이 화면에서 다시 묻지 않는다.
import { useCallback, useRef } from "react";
import { api, errText } from "../api";
import type { Notify } from "../App";
import { t } from "../i18n";
import { unaskedTerms } from "../vocab";

export function useGlossarySuggest(notify: Notify) {
  const asked = useRef(new Set<string>());
  return useCallback(
    (all: string[]) => {
      const terms = unaskedTerms(asked.current, all);
      if (!terms.length) return;
      for (const x of terms) asked.current.add(x);
      const term = terms.join(", ");
      notify({
        text: t("자주 쓰는 단어에 추가할까요? — {term} (다음 녹음부터 더 정확하게 인식합니다)", { term }),
        action: {
          label: t("추가"),
          run: () =>
            void api.glossaryAdd(terms).then(
              (n) => notify({ text: n ? t("자주 쓰는 단어에 추가했습니다 — {term} (다음 녹음부터 더 정확하게 인식합니다)", { term }) : t("이미 자주 쓰는 단어에 있습니다 — {term}", { term }) }),
              (e) => notify({ text: t("자주 쓰는 단어에 추가하지 못했습니다: {error}", { error: errText(e) }), error: true }),
            ),
        },
      });
    },
    [notify],
  );
}
