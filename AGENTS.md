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
Aplaybox(www.aplaybox.com) 작가의 모델·모션 배포 자료를 목록으로 보고, 다운로드 조건(팔로우·좋아요·즐겨찾기)을 처리해 내려받는 Windows용 Electron 포터블 앱.
- 저장소: `homerthegood/ApbDownloader` (공개). 자동 업데이트는 이 저장소의 최신 GitHub 릴리스를 확인한다.
- 런타임: Electron 45.3.1 (Build.ps1이 공식 ZIP을 받아 SHA-256 검증 후 `vendor/electron`에 풂). Node.js 설치는 필요 없다.

## 폴더 구조
| 경로 | 내용 |
|---|---|
| `src/main.js` | 메인 프로세스: IPC(`handle(...)`), 설정·기록 저장(`atomic`), 다운로드 대기열, 작가 목록 캐시, 번역, 3ds Max 연동 IPC |
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
   - 빌드 → 스모크 테스트 → `release/v<버전>/AplayboxDownloader-Windows-x64.zip` → 태그 `v<버전>` 푸시 → GitHub 릴리스(노트 = 인수인계 파일의 `## 릴리스 노트` 절) → 업로드 SHA-256 대조.
   - 자기 PC의 포터블 설치 폴더도 갱신하려면 `-InstallDir <폴더>` (그 폴더에서 앱이 실행 중이면 건너뜀, data 유지).
   - gh CLI 로그인 필요(`gh auth login`).
6. 자동 업데이트는 릴리스 자산 이름 `AplayboxDownloader-Windows-x64.zip`과 GitHub가 주는 `digest`(sha256)에 의존한다. 이름을 바꾸지 말 것.

## 구현 규칙·주의
- CSP: `default-src 'self'; style-src 'self'; script-src 'self'` — 인라인 스타일/스크립트 금지, 외부 리소스 금지.
- 창 제목 표시줄은 숨기고(`titleBarStyle:'hidden'`) `.app-titlebar`(높이 `--titlebar-h`)와 Windows 창 버튼 오버레이를 쓴다. 테마 색을 바꾸면 테마 CSS의 `--titlebar-bg/--titlebar-fg`와 `theme.js`의 `TITLE`을 함께 바꾼다. 화면 맨 위에 붙는 fixed 요소는 `--titlebar-h`만큼 내린다.
- 테마 색은 각 테마의 CSS 변수(`--accent`, `--panel`, `--line`, `--text`, `--muted`)를 쓴다. 공통 규칙은 `readability.css`, 테마별 차이만 테마 파일에.
- 렌더러에서 메인 기능을 부르려면: `main.js`에 `handle('이름', fn)` → `preload.js` `allowed`에 추가 → UI에서 `window.aplay.call('이름', ...)` (결과 `{ok, value|error}`).
- 업데이트 교체 스크립트는 Electron 종료 시 자식 프로세스가 같이 죽으므로 `cmd /c start`로 분리 실행한다(`updater.js`).
- 사이트 조건 처리는 실제 사이트 흐름(`downloadAdvertCheck`)을 그대로 실행한다. CAPTCHA·광고 단계를 우회하지 않는다.
- 모델 디스플레이 뷰어: `src/viewer.js`(WebContentsView, details.aplaybox.com만 허용). 렌더러는 `#viewerStage` 좌표를 `viewerOpen`/`viewerBounds`로 보냄. 확인창은 `confirm()` 대신 `appConfirm()`(`src/ui/popups.js`), 툴팁은 `title` 속성을 그대로 쓰면 자동 변환.

## 3ds Max 임포트 연동
- 흐름: 다운로더 → `%LOCALAPPDATA%\ApbDownloader\max-bridge\requests\<PID>-<시각>.txt` 작성 → 해당 Max 안의 `ApbMaxBridge.ms`(1초 타이머)가 읽고 삭제 → 내장 `src/max/ImportMMD.ms` 창을 열고 `enqueueAndRun` → Blender(mmd_tools)로 PMX→FBX → 임포트.
- 실행 중인 Max 목록: 각 Max가 `instances\<PID>.txt`(PID·연도·상태·씬 이름)를 1초마다 기록. 다운로더는 tasklist의 3dsmax.exe PID와 대조.
- `ApbMaxBridge.ms`는 사용자 동의 후 `%LOCALAPPDATA%\Autodesk\3dsMax\<연도> - 64bit\<언어>\scripts\startup`에 복사. 새로 띄우는 Max는 `-U MAXScript <ApbMaxBridge.ms>`로도 시작.
- 임포터 설정 `ImportMMD.ini`(UTF-16LE BOM)와 로그는 max-bridge 폴더. 앱의 "3ds Max 임포트 설정" 창이 Blender·반디집 경로를 이 INI에 쓴다.
- 미니 리스너에 WM_SETTEXT로 명령을 보내는 방식은 미니 리스너가 숨겨진 환경에서 동작하지 않아 쓰지 않는다.
- MaxScript 주의: `a.B().C` 같은 메서드 호출 뒤 속성 연결 불가 → `(a.B()).C`. 구조체 멤버 함수는 뒤에 정의된 멤버를 호출할 수 없음. 변수명 대소문자 구분 없음.
- 검증: `3dsmaxbatch.exe <스크립트.ms>`로 문법/로드 확인, GUI 동작은 실제 Max를 띄워 요청 파일로 확인(사용자가 켜 둔 Max에는 명령을 보내지 말 것).

## 번역 엔진
- 설정: 헤더 ⚙ 설정 창(`#settingsDialog`) → "번역 설정" 창. 값은 `settings.json`의 `translateEngine`(google|claude), `translateModel`(haiku|sonnet), `claudePath`(직접 지정 시). IPC `translationEngine(op, value)`.
- 압축 파일 이름 번역: `settings.json`의 `translateFileNames`(기본 false), IPC `fileNameTranslation(bool)`. `translation.js`의 `translatedFileName(name,{title,cached,glossary})`가 저장된 번역(`Translator.cached`: 모든 엔진 버킷 조회, 요청 없음)만 사용 → 파일 이름 전체 번역 → 이름 속 게시물 제목 교체 → 용어집 순. `core.download`의 `rename` 콜백은 확장자가 같을 때만 적용. 이름이 바뀐 파일은 기록(history) 없이 이름만으로는 폴더 존재 판정이 맞지 않음.
- Claude: Claude 데스크탑 앱에 포함된 Claude Code CLI(`%LOCALAPPDATA%Claude-Dataclaude_*claude-code<버전><해시>claude.exe`, 최고 버전 우선)를 다음 옵션으로 실행한다. 빈 임시 폴더에서, 입력은 stdin의 JSON 배열.
  `-p --model <m> --output-format json --tools "" --no-session-persistence --strict-mcp-config --system-prompt <번역 지시>`
  - 도구·MCP·세션 저장을 끈 상태라 제목 속 지시문은 데이터로만 번역된다. `--bare`는 OAuth 로그인을 건너뛸 수 있어 쓰지 않는다.
  - 300ms 안에 모인 제목(최대 40개)을 한 번에 보낸다(호출당 약 3~6초). 한 번에 한 프로세스.
  - 실패(미로그인·한도·형식 오류) 시 해당 제목은 Google로, Claude는 5분 쉼. 한글이 없는 결과(원문 반복)도 Google로.
  - 용어집 용어는 보내기 전에 원문에서 한국어로 치환한다(모델이 공식 이름을 틀리는 문제 대응).
- Codex(ChatGPT) CLI 엔진은 미구현(사용량 제한으로 시험 못 함). 추가 시 `claude-cli.js`와 같은 형태의 모듈을 만들고 `ENGINES`에 등록.

## 데이터 파일 (`data/`, 앱 폴더 옆)
`settings.json`, `history.json`(다운로드 기록·경로·SHA-256), `bookmarks.json`, `author-lists.json`(작가 목록 캐시), `author-updates.json`(북마크 작가 새 모델 확인 기록: seen·newIds), `translations.json`(번역 캐시), `glossary.txt`(사용자 용어집, 선택), `session.enc`(safeStorage 암호화 쿠키), `update.log`, `update-result.json`.
