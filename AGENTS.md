# AGENTS.md — Aplaybox Downloader 개발 안내 (Codex · Claude Code 공용)

이 파일은 AI 코딩 도구(Codex, Claude Code 등)와 사람이 이 저장소를 이어서 개발할 때 먼저 읽는 문서입니다.
`CLAUDE.md`는 이 파일을 불러옵니다. 버전별 상태·남은 작업은 `docs/handoff/v<버전>.md`에 있습니다(가장 최신 파일부터 읽을 것).

## 응답·작업 규칙
- 사용자와 UI 문구는 한국어, 사무적인 말투.
- 사용자의 확인 없이 GitHub 릴리스·푸시를 하지 않는다. "빌드만"이라고 하면 `scripts/release.ps1`을 `-Publish` 없이 실행한다.
- 개인 정보(이메일, 로그인 세션, 계정 ID)를 커밋·릴리스·로그에 넣지 않는다. 커밋 이메일은 GitHub noreply.
- `data/`(session.enc, history.json, bookmarks, settings, translations.json 등)는 절대 빌드·ZIP·커밋에 포함하지 않는다. 사용자 설치 폴더의 `data/`를 덮어쓰지 않는다.
- `research/`(사이트 소스 덤프)는 공개하지 않는다(.gitignore).

## 프로젝트 개요
Aplaybox(www.aplaybox.com) 업로더의 모델·모션 배포 자료를 목록으로 보고, 다운로드 조건(팔로우·좋아요·즐겨찾기)을 처리해 내려받는 Windows용 Electron 포터블 앱.
- 저장소: `homerthegood/ApbDownloader` (공개). 자동 업데이트는 이 저장소의 최신 GitHub 릴리스를 확인한다.
- 런타임: Electron 45.3.1 (Build.ps1이 공식 ZIP을 받아 SHA-256 검증 후 `vendor/electron`에 풂). Node.js 설치는 필요 없다.

## 폴더 구조
| 경로 | 내용 |
|---|---|
| `src/main.js` | 메인 프로세스: IPC(`handle(...)`), 설정·기록 저장(`atomic`), 다운로드 대기열, 업로더 목록 캐시, 번역, 3ds Max 연동 IPC |
| `src/preload.js` | 렌더러에 노출하는 `window.aplay.call(method, ...)`. **새 IPC는 여기 `allowed` 목록에 추가해야 동작** |
| `src/core.js` | 페이지 검증, 조건 판정, 안전한 파일 저장·SHA-256 |
| `src/site.js` | Aplaybox API 형식, 사이트 창, 다운로드 인증 흐름 (사이트가 바뀌면 여기 수정) |
| `src/browser.js`, `src/page-translation.js`, `src/site-preload.js` | 내장 Aplaybox 탐색기와 페이지 번역 |
| `src/translation.js` | 번역기: 엔진 선택(Google 무료 엔드포인트 / Claude), Claude 묶음 대기열, 실패 시 Google 대체, 캐시(`data/translations.json`) |
| `src/claude-cli.js`, `src/glossary.js` | Claude Code CLI 탐색·실행·응답 해석 / 게임 용어집(기본 + `data/glossary.txt`) |
| `src/existing.js` | 저장 폴더에 이미 있는 모델 판정 |
| `src/updater.js` | 시작 시 GitHub 릴리스 확인 → 다운로드 → 앱 종료 후 교체(robocopy, data 제외) → 재시작 |
| `src/maxbridge.js` + `src/max/` | 3ds Max 임포트 연동(아래 참고) |
| `src/ui/` | 한국어 UI. `ui.js`(목록·설정), `activity.js`(작업 현황·플로팅 버튼), `update.js`(업데이트 진행), `theme.js` |
| `src/ui/*.css` | `style.css` → `readability.css`(공통) → `theme-bento.css`(화면 이름 **Light**, 기본) / `theme-dark.css` / `theme-aero.css` |
| `test/` | `node:test` 단위 테스트 |
| `tools/preview/` | 가짜 데이터로 UI 스크린샷 (README 참고) |
| `scripts/release.ps1` | 빌드·스모크 테스트·ZIP·(선택) 게시 |
| `docs/handoff/` | 릴리스별 인수인계 노트 |

## 개발 명령 (Windows, Git Bash 기준)
```bash
# 최초 1회: Electron 런타임 준비 + dist 빌드
powershell -NoProfile -ExecutionPolicy Bypass -File Build.ps1

# 소스에서 실행 (데이터는 ./data)
./vendor/electron/electron.exe .
# 별도 데이터 폴더로 실행 / 원격 디버깅(CDP)으로 조작
APLAYBOX_DATA=/tmp/apb ./vendor/electron/electron.exe . --remote-debugging-port=9333

# 테스트 (Node 대신 Electron을 Node 모드로 사용)
ELECTRON_RUN_AS_NODE=1 ./vendor/electron/electron.exe --test test/*.test.js
# 문법 검사
ELECTRON_RUN_AS_NODE=1 ./vendor/electron/electron.exe --check src/main.js
```
- 공개 데이터만 읽는 실사이트 점검: 빌드된 exe에 `--smoke-test` (결과 `data/live-verification.json`).
- PowerShell 스크립트(.ps1)와 MaxScript(.ms)에 한글이 있으면 **UTF-8 BOM**으로 저장해야 한다(Windows PowerShell 5.1, 3ds Max).

## 릴리스 절차
1. `package.json`의 `version`을 올린다.
2. `docs/handoff/TEMPLATE.md`를 복사해 `docs/handoff/v<버전>.md`를 작성한다(변경 사항, 검증, 미확인, 다음 작업, **릴리스 노트**). **릴리스마다 필수** — 없으면 `-Publish`가 거부된다.
3. 이 파일(AGENTS.md)의 구조·규칙이 바뀌었으면 함께 갱신한다.
4. 테스트 통과 확인 후 커밋.
5. `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -Publish`
   - 빌드 → 스모크 테스트 → 언어 팩 정리(ko·en-US만 남김) → `release/v<버전>/AplayboxDownloader-Windows-x64.zip`과 `.7z`(반디집 `bz.exe` 필요, 없으면 `-Publish`는 중단) → 태그 `v<버전>` 푸시 → GitHub 릴리스(노트 = 인수인계 파일의 `## 릴리스 노트` 절) → 업로드 SHA-256 대조.
   - 자기 PC의 포터블 설치 폴더도 갱신하려면 `-InstallDir <폴더>` (그 폴더에서 앱이 실행 중이면 건너뜀, data 유지).
   - gh CLI 로그인 필요(`gh auth login`).
6. 자동 업데이트는 릴리스 자산 이름 `AplayboxDownloader-Windows-x64.7z`·`.zip`과 GitHub가 주는 `digest`(sha256)에 의존한다. 이름을 바꾸지 말 것. 7z를 먼저 받고(Windows 내장 `tar.exe`로 해제) 실패하면 ZIP으로 넘어간다. 2.0.0 이하 버전은 ZIP만 알기 때문에 ZIP을 릴리스에서 빼면 그 사용자들의 자동 업데이트가 끊긴다.

## 구현 규칙·주의
- CSP: `default-src 'self'; style-src 'self'; script-src 'self'` — 인라인 스타일/스크립트 금지, 외부 리소스 금지.
- 창 제목 표시줄은 숨기고(`titleBarStyle:'hidden'`) `.app-titlebar`(높이 `--titlebar-h`)와 Windows 창 버튼 오버레이를 쓴다. 테마 색을 바꾸면 테마 CSS의 `--titlebar-bg/--titlebar-fg`와 `theme.js`의 `TITLE`을 함께 바꾼다. 화면 맨 위에 붙는 fixed 요소는 `--titlebar-h`만큼 내린다.
- 테마 색은 각 테마의 CSS 변수(`--accent`, `--panel`, `--line`, `--text`, `--muted`)를 쓴다. 공통 규칙은 `readability.css`, 테마별 차이만 테마 파일에.
- 렌더러에서 메인 기능을 부르려면: `main.js`에 `handle('이름', fn)` → `preload.js` `allowed`에 추가 → UI에서 `window.aplay.call('이름', ...)` (결과 `{ok, value|error}`).
- 업데이트 교체 스크립트는 Electron 종료 시 자식 프로세스가 같이 죽으므로 `cmd /c start`로 분리 실행한다(`updater.js`).
- 사이트 조건 처리는 실제 사이트 흐름(`downloadAdvertCheck`)을 그대로 실행한다. CAPTCHA·광고 단계를 우회하지 않는다.
- 모델 디스플레이 뷰어: `src/viewer.js`(WebContentsView, details.aplaybox.com만 허용). 렌더러는 `#viewerStage` 좌표를 `viewerOpen`/`viewerBounds`로 보냄. 내장 탐색기에서 모델 링크를 누르면 `browser.js`의 `onModel`→`main.js` `previewFromBrowser`가 같은 뷰어를 탐색기 위에 띄운다(`viewerOver==='browser'`이면 버튼 동작을 main이 처리, 설정 `browserPreview`). 뷰어 화면 위 버튼(업로더 페이지·게시물 열기·다운로드·닫기)은 `src/viewer-preload.js`가 페이지 안에 그리고 `viewer-action`으로 알린다(네이티브 뷰가 앱 화면을 덮으므로). 확인창은 `confirm()` 대신 `appConfirm()`(`src/ui/popups.js`), 툴팁은 `title` 속성을 그대로 쓰면 자동 변환.

## 다운로드 진행 구조
- `main.js`의 `start()`는 게시물 하나를 한 절차로 처리한다: 조건·첨부 확인(`resolveWork`) 직후 같은 자리에서 그 게시물의 파일을 내려받는다. 동시에 처리하는 게시물 수는 `concurrency`(또는 `concurrencyUnlimited`) 하나뿐이고 별도의 확인 단계·설정(`checkConcurrency`)은 없다. 사이트 확인 요청만 내부적으로 동시에 10개까지로 묶는다(`checkSlot`).
- 계정 조건 처리(`C.fulfill`)는 `serialCondition`으로 한 번에 한 게시물만 실행한다(같은 업로더 팔로우 중복 토글 방지). 사이트 창(`site.resolve`)은 게시물마다 따로 열려 동시에 진행된다.
- 동시 다운로드·무제한·동시 확인은 IPC `downloadOptions`로 즉시 저장한다(로그인 불필요). 계정별 자동 처리 범위는 기존 `settings`.
- 작업 중 `selection`은 상태가 '완료'인 게시물 전체 선택만 허용하고 `picked`로 표시한다. 독의 3ds Max 버튼은 작업 중에 `picked` 자료만 보낸다(`activity.js` `maxImportTargets`).
- 첨부 파일 줄의 체크박스는 화면에 그리지 않는다(`.file-toggle`은 키보드·스크린리더용으로 남김). 받지 않는 줄은 `.file.off`.

## 3ds Max 임포트 연동
- 흐름: 다운로더 → `%LOCALAPPDATA%\ApbDownloader\max-bridge\requests\<PID>-<시각>.txt` 작성 → 해당 Max 안의 `ApbMaxBridge.ms`(1초 타이머)가 읽고 삭제 → 내장 `src/max/ImportMMD.ms` 창을 열고 `enqueueAndRun` → Blender(mmd_tools)로 PMX→FBX → 임포트.
- 실행 중인 Max 목록: 각 Max가 `instances\<PID>.txt`(PID·연도·상태·씬 이름)를 1초마다 기록. 다운로더는 tasklist의 3dsmax.exe PID와 대조.
- `ApbMaxBridge.ms`는 사용자 동의 후 `%LOCALAPPDATA%\Autodesk\3dsMax\<연도> - 64bit\<언어>\scripts\startup`에 복사. 새로 띄우는 Max는 `-U MAXScript <ApbMaxBridge.ms>`로도 시작.
- 임포터 설정 `ImportMMD.ini`(UTF-16LE BOM)와 로그는 max-bridge 폴더. 앱의 "3ds Max 임포트 설정" 창이 Blender·반디집 경로를 이 INI에 쓴다.
- 임포트 결과: `ImportMMD.ms`의 `addResult`가 `max-bridge\results\<시각>-<n>.txt`에 `ok|fail<TAB>원본<TAB>pmx<TAB>메시지`를 쓴다. 앱은 요청이 대기 중일 때 2초마다 읽고 지워(`maxbridge.js` `takeResults`·`applyResults`) `data/max-imports.json`(게시물 id → `{state: sent|done|failed, time, message}`)에 기록한다. 스냅샷의 `work.maxImport`, 탭 '임포트 완료'(`tab-imported`). 앱 종료 시 `sent`로 남은 요청은 다음 시작 때 지운다.
- 임포트 창: 렌더러가 `maxImportPlan(ids)`(파일·대상 Max 목록·현재 옵션)을 받아 `#maxImportDialog`를 띄우고 `maxImport(ids,{target,options})`를 호출한다. 옵션은 `maxbridge.js`의 `OPTION_DEFS`·`importOptions`·`optionsToIni`로 ImportMMD.ini에 쓰고, `ImportMMD.ms`의 `enqueueAndRun`이 임포트 중이 아닐 때 `loadSettings`로 다시 읽는다. 옵션을 추가하면 `OPTION_DEFS`, `ui.js`의 `MX_FIELDS`, `index.html`의 창을 함께 고친다.
- 메인 프로세스가 사용자에게 묻는 것(버전 선택, 연동 설치)은 OS 메시지 상자 대신 `askRenderer` → 렌더러 `appChoice`(`popups.js`) → `appAnswer`로 처리한다. 파일 선택 창(showOpenDialog)만 OS 창을 쓴다.
- 일괄 처리(`ImportMMD.ms` `runBatch`): 파일 순서대로 PMX 목록을 만들며 `ImportMMDTask`를 쌓고, `pumpConverts`가 Blender를 `parallelBlender`(INI `ParallelBlender`, 1~8, 기본 3)개까지 동시에 돌린다. 임포트(`importFbx`)는 파일 순서대로 하나씩. `ReuseFbx`가 켜져 있고 `<stem>.key.txt`(PMX 크기·수정 시각, 모프·메시·스케일, 변환 스크립트 수정 시각)가 같으면 변환을 건너뛴다. 구조체 멤버 함수는 앞에 정의된 멤버만 부를 수 있으므로 순서를 지킬 것.
- 상단 배치: 앱 이름 배너(`<header>`)와 맨 윗줄(`.collapse-bar`, 상단 접기)은 없다. 테마 선택(`#themeSelect`)은 탭 줄의 번역 메뉴 왼쪽, 버전은 앱 아이콘(`#brand`) 툴팁(스냅샷의 `version`)에 나온다. `#topRow` 한 줄에 앱 아이콘(`.brand`) · 북마크 버튼(`#defaultAuthorButtons`, 렌더 때 내용 전체 교체) · 계정/로그인/로그아웃/설정(`.account`)이 들어간다. 목록 툴바는 `.selection`을 `display:contents`로 풀고 `order`로 선택 버튼 → 필터(작은 버튼, 펼침 창) → 요약 → 검색·정렬 → 썸네일 → 새로고침 순서의 한 줄을 만든다(`readability.css` 끝부분).
- 북마크 버튼: 기본 업로더와 사용자가 추가한 업로더를 한 목록으로 다룬다(`main.js` `shortcutAuthors` → 스냅샷 `authorShortcuts`, 렌더러 `authorList`). 같은 id의 사용자 항목이 기본 업로더를 대신하고(이름 변경), 삭제한 기본 업로더는 `hiddenAuthors`, 순서는 `authorOrder`(IPC `authorOrder`, 버튼을 드래그해 바꿈)에 저장한다. 새 모델 확인(`checkBookmarkUpdates`)도 이 목록 전체가 대상이다. 정렬은 숨은 `#sort`(new|old)와 `#sortToggle` 버튼.
- 엔진 빠른 선택(목록 탭 줄 `.tabs-row`의 오른쪽 끝, 하위 목록은 왼쪽으로 열림): 값은 숨은 `<select id="trQuick">`(`google` | `<엔진>:<모델>` | `off`)이 들고 화면은 `#trMenu` 메뉴(`ui.js` `buildEngineMenu`·`syncEngineMenu`)가 그린다. 모델이 둘 이상인 엔진은 하위 메뉴(호버·클릭·방향키)로 나온다. `off`(번역 사용 안 함)가 예전 자동 번역 체크박스를 대신하며 `syncQuickValue`가 `state.autoTranslate`와 맞춘다. 검색은 돋보기 버튼(`#searchToggle`)으로 펼친다.
- 전체 기록 삭제(`#clearRecords`, `ui.js` `CLEAR_RECORDS`): 탭별로 `progressForget`(진행·실패 상태만 초기화)·`downloadForget`·`maxImportForget`을 탭의 모든 자료에 호출.
- 기록 삭제: IPC `downloadForget`(history와 완료 상태 제거, 작업 중 불가)·`maxImportForget`. 렌더러는 `activity.js`의 `FORGET` 표로 탭별 동작을 정한다.
- 미니 리스너에 WM_SETTEXT로 명령을 보내는 방식은 미니 리스너가 숨겨진 환경에서 동작하지 않아 쓰지 않는다.
- MaxScript 주의: `a.B().C` 같은 메서드 호출 뒤 속성 연결 불가 → `(a.B()).C`. 구조체 멤버 함수는 뒤에 정의된 멤버를 호출할 수 없음. 변수명 대소문자 구분 없음.
- 검증: `3dsmaxbatch.exe <스크립트.ms>`로 문법/로드 확인, GUI 동작은 실제 Max를 띄워 요청 파일로 확인(사용자가 켜 둔 Max에는 명령을 보내지 말 것).

## 번역 엔진
- 설정: 오른쪽 위 ⚙ 설정 창(`#settingsDialog`) → "번역 설정" 창. 값은 `settings.json`의 `translateEngine`(google|claude|codex), `translateModel`(haiku|sonnet|opus|fable — Claude Code가 계열별 최신 모델로 바꿔 주는 별칭), `claudePath`(직접 지정 시), `codexModel`(Codex 모델 이름), `codexPath`. IPC `translationEngine(op, value)`.
- 압축 파일 이름 번역: `settings.json`의 `translateFileNames`(기본 false), IPC `fileNameTranslation(bool)`. `translation.js`의 `translatedFileName(name,{title,cached,glossary})`가 저장된 번역(`Translator.cached`: 모든 엔진 버킷 조회, 요청 없음)만 사용 → 파일 이름 전체 번역 → 이름 속 게시물 제목 교체 → 용어집 순. `core.download`의 `rename` 콜백은 확장자가 같을 때만 적용. 이름이 바뀐 파일은 기록(history) 없이 이름만으로는 폴더 존재 판정이 맞지 않음.
- Claude: Claude 데스크탑 앱에 포함된 Claude Code CLI(`%LOCALAPPDATA%Claude-Dataclaude_*claude-code<버전><해시>claude.exe`, 최고 버전 우선)를 다음 옵션으로 실행한다. 빈 임시 폴더에서, 입력은 stdin의 JSON 배열.
  `-p --model <m> --output-format json --tools "" --no-session-persistence --strict-mcp-config --system-prompt <번역 지시>`
  - 도구·MCP·세션 저장을 끈 상태라 제목 속 지시문은 데이터로만 번역된다. `--bare`는 OAuth 로그인을 건너뛸 수 있어 쓰지 않는다.
  - 300ms 안에 모인 제목을 16개씩 묶어(`BATCH`) 최대 `parallel`개(설정 `translateParallel`, 1~4, 기본 3)의 프로세스로 동시에 보낸다. 호출 한 번은 시작에 약 3초, 제목당 약 0.3초가 들기 때문이다(96개 기준 40개씩 순차 21초 → 9초). 한 묶음이 실패하면 대기 중인 묶음은 CLI를 거치지 않고 Google로 넘긴다.
  - 요청 문장(`REQUEST`)을 본문에도 넣는다. 배열만 보내면 Haiku가 묶음을 번역하지 않고 그대로 되돌려 보내는 일이 잦았다(96개 중 34개 → 0개).
  - 실패(미로그인·한도·형식 오류) 시 해당 제목은 Google로, Claude는 5분 쉼. 한글이 없는 결과(원문 반복)도 Google로.
  - 용어집 용어는 보내기 전에 원문에서 한국어로 치환한다(모델이 공식 이름을 틀리는 문제 대응).
- 계정 연결: 엔진을 Claude로 바꿀 때 `claude auth status --json`이 미로그인이면 `claude auth login --claudeai`를 실행하는 연결 창을 띄운다(`claude-cli.js` `loginStart`, IPC `claudeAccount` login/loginCode/loginOpen/loginCancel, 이벤트 `claude-login`). CLI가 브라우저를 열고 주소를 출력한 뒤 승인 또는 stdin 코드 입력을 기다린다. Claude 데스크탑 앱에 로그인되어 있어도 CLI 단독 실행은 미로그인일 수 있다. Claude-Data 폴더 이름은 `claude_*` 또는 스토어 패키지형 `anthropicpbc.claude_*`.
- ChatGPT(Codex): `src/codex-cli.js`. 실행 파일은 `%LOCALAPPDATA%\OpenAI\Codexin\<해시>\codex.exe`(수정 시각이 최신인 것), 직접 지정은 `settings.json`의 `codexPath`. 모델 설정 `codexModel`은 실제 모델 이름(slug)이며 `%USERPROFILE%\.codex\models_cache.json`의 표시 대상(`visibility: list`) 모델 중에서 고른다. 화면의 모델 목록과 빠른 선택 항목도 이 목록으로 채운다(이름이 자주 바뀌므로 하드코딩 금지). 값이 없거나 목록에 없는 이름이면 luna 계열 첫 항목을 쓰고(`chooseModel`), 이전 빌드가 저장한 `fast`/`accurate`는 luna/sol 계열로 바꾼다. 목록을 못 읽으면 `FALLBACK`. 번역 저장 버킷은 `codex:<모델 이름>`. `~/.codex/auth.json`은 읽지 않는다.
  - 실행: `codex exec --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules -s read-only -C <빈 임시 폴더> -m <모델> -c model_reasoning_effort="low" -o <결과 파일> --color never -`, 지시문과 JSON 배열을 stdin 한 덩어리로 보낸다. 3개 제목 약 4초.
  - 계정: `codex login status`(이메일은 나오지 않음) / `codex login`(브라우저 로그인, 코드 입력 없음) / `codex logout`. IPC `codexAccount`는 `claudeAccount`와 같은 `accountHandler`를 쓰고 진행 이벤트(`claude-login`)에 `provider`가 붙는다.
  - 번역기(`translation.js`)는 `llm()`으로 엔진별 CLI·실행 파일·모델·버킷 키를 고른다. 묶음 대기열·Google 대체·쉬는 시간은 Claude와 공유한다. 렌더러는 `ui.js`의 `LLM` 표 하나로 두 엔진의 라벨·모델·계정 IPC를 다룬다. 엔진을 추가하면 `ENGINES`, `llm()`, `LLM` 표, `index.html`의 선택 항목과 계정 줄을 함께 고친다.

## 내장 데이터 (`src/builtin/`)
- `author-lists.json`: 기본 업로더(`default-authors.js`)의 게시물 목록(id·제목·표지 주소·날짜·업로더만, 사용자 상태 없음). `main.js` `cachedList`가 사용자 캐시가 없을 때 `builtinList`로 쓴다.
- `translations.json`: 그 제목·업로더 이름의 번역(`{source, entries}`). `Translator.loadBuiltin`으로 읽으며 우선순위가 가장 낮고, 저장 파일에 쓰지 않고, 지우기에도 남고, "새로 번역"에서는 쓰지 않는다.
- 갱신: 기본 업로더 목록을 불러오고 원하는 엔진으로 번역한 데이터 폴더를 대상으로 `ELECTRON_RUN_AS_NODE=1 ./vendor/electron/electron.exe tools/build-builtin.cjs [데이터 폴더] [번역 버킷, 기본 claude:fable]`. 공개 사이트에 보이는 정보와 번역만 담긴다(생성 후 개인 정보가 없는지 확인할 것).

## 데이터 파일 (`data/`, 앱 폴더 옆)
`settings.json`, `history.json`(다운로드 기록·경로·SHA-256), `bookmarks.json`, `author-lists.json`(업로더 목록 캐시), `author-updates.json`(북마크 업로더 새 모델 확인 기록: seen·newIds), `max-imports.json`(3ds Max 임포트 결과), `translations.json`(번역 캐시), `glossary.txt`(사용자 용어집, 선택), `session.enc`(safeStorage 암호화 쿠키), `update.log`, `update-result.json`.
