---
name: daily-suggest
description: Morning briefing — 알아야 될 것 + 작업 제안 + 아이디어
---

매일 아침 브리핑. 3섹션으로 구분해서 보고.

## 데이터 수집

### 캘린더 (오늘+내일)
```bash
osascript -e 'tell application "Calendar"
    set today to current date
    set time of today to 0
    set dayAfter to today + 2 * days
    set results to {}
    repeat with c in calendars
        try
            set evts to (every event of c whose start date ≥ today and start date < dayAfter)
            repeat with e in evts
                set end of results to (summary of e) & " | " & (start date of e as string)
            end repeat
        end try
    end repeat
    return results
end tell'
```

### 서비스 상태
```bash
cat /tmp/ghostship/error-scan-latest.md
```

### tossctl 세션
```bash
tossctl auth status 2>/dev/null | head -3
```

### RSS (최근 12시간 주요 뉴스)
```bash
sqlite3 ~/project/ghostship-rss/data/rss.db "SELECT feed_name, title FROM entries WHERE created_at > datetime('now', '-12 hours') ORDER BY published DESC LIMIT 15"
```

### 프로젝트 상태
```bash
# 커밋 안 된 변경
for d in ~/project/ghostship-bridge ~/project/ghostship-orb ~/project/skillduler ~/project/ghostship-webhook ~/project/ghostship-rss; do
  name=$(basename "$d")
  changes=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  unpushed=$(git -C "$d" log --oneline @{u}..HEAD 2>/dev/null | wc -l | tr -d ' ')
  if [ "$changes" != "0" ] || [ "$unpushed" != "0" ]; then
    echo "$name: ${changes} uncommitted, ${unpushed} unpushed"
  fi
done
```

### 최근 세션 (어제 뭐 했는지)
최근 claude 세션 로그에서 주요 작업 추출:
```bash
ls -lt ~/.claude/projects/-Users-ghostship/*.jsonl 2>/dev/null | head -1
```
최신 .jsonl에서 assistant 메시지의 tool_use (Edit, Write, Bash) 패턴으로 어제 작업 요약.

### 포트폴리오 (선택)
tossctl 세션이 살아있으면:
```bash
tossctl account summary --output json 2>/dev/null
```

## 섹션 1: 알아야 될 것

놓치면 안 되는 것만. 없으면 "없음" 한 줄.

- 오늘/내일 캘린더 일정
- 포폴 종목 관련 뉴스 (RSS에서 보유 종목명 매칭)
- 서비스 에러 (error-scan에서 NEW 에러)
- tossctl 세션 만료 여부
- 중요 거시경제 이벤트 (FOMC, CPI, 실적발표)

## 섹션 2: 작업 제안

안 해도 되지만 하면 좋은 것. 구체적으로. 있는 만큼 다 적을 것.

소스:
- 밀린 커밋/푸시
- error-scan에서 잡힌 미수정 건
- brew outdated 체크
- 기술부채 (이전 리뷰에서 나온 미해결 건)
- orb 정리 필요한 것

## 섹션 3: 아이디어

영감/탐색 거리. 있는 만큼 다 적을 것.

소스:
- RSS에서 흥미로운 기술 뉴스/도구
- CivitAI 트렌딩 LoRA/모델 (WebSearch)
- 니 프로젝트에서 파생 가능한 아이디어
- 투자 관련 새 기회

## Phase 3: 작업 제안을 승인 버튼으로 전송

[작업] 섹션의 각 항목 중 council에서 자동 처리 가능한 것은 webhook /suggest API로 전송.
이렇게 하면 사용자가 텔레그램에서 [승인] [패스] 버튼으로 바로 결정 가능.

작업 항목을 수집한 후 아래 명령 실행:
```bash
curl -s -X POST http://localhost:3100/suggest -H 'Content-Type: application/json' -d '{
  "suggestions": [
    {"description": "작업 설명", "project": "~/project/프로젝트명", "type": "code", "command": "실행할 셸 명령"},
    ...
  ]
}'
```

type 값: code (코드 수정), infra (인프라), docs (문서), analysis (분석)
project: 해당 프로젝트 경로. 모르면 생략.
command: 승인 시 실행할 셸 명령 (최대 1000자). **선택.**

command 예시:
- 단순 작업: "git -C ~/project/ghostship-bridge push"
- brew: "brew upgrade 패키지명"
- 리뷰 필요한 작업: command 생략 (승인 시 자동으로 active → crew/council 루프 진입)

command가 있으면 승인 즉시 실행 → done. command가 없으면 승인 시 active로 전환되어 crew/council 리뷰 루프에 진입.

자동화 불가능한 항목 (투자 결정, 물리적 행동 등)은 /suggest로 안 보내고 stdout에만 출력.

## 규칙
- [알림]과 [아이디어]는 stdout으로 출력 (skillduler가 텔레그램 전송).
- [작업]은 /suggest API로 보내서 인라인 버튼으로 전달. stdout에도 요약 출력.
- 플레인텍스트. 길면 나눠서 출력 (skillduler가 4096자 단위로 분할 전송).
- 빈 섹션은 "없음" 한 줄로.
- 추측하지 말 것. 확인된 것만 적을 것.
- 아이디어는 "이거 해봐"가 아니라 "이런 게 있더라" 톤으로.

## 출력 형식

[알림]
- 일정/뉴스/에러/세션 등

[작업] (승인 버튼으로도 전송됨)
1. 구체적 작업 (예: "bridge 커밋 3개 unpushed")
2. ...

[아이디어]
- 흥미로운 것 (예: "CivitAI에 새 X LoRA 트렌딩")
