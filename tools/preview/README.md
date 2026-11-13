# UI 미리보기

실제 계정·네트워크 없이 `src/ui`를 가짜 데이터로 띄워 스크린샷을 찍습니다. 테마·레이아웃 변경을 확인할 때 씁니다.

```bash
# 저장소 루트에서 (Git Bash)
rm -rf tools/preview/profile
PREV_THEME=bento PREV_MODE=download ./vendor/electron/electron.exe tools/preview/run.cjs "$PWD"
```

- `PREV_THEME`: `bento`(화면 이름 Light) / `dark` / `aero`
- `PREV_MODE`: `download`(다운로드 중) / `idle`(완료 후) / `list`(목록 조회 중) / `empty`(빈 목록, 첫 실행)
- `PREV_JS`: 캡처 전에 페이지에서 실행할 JavaScript (예: 대화상자 열기). 결과는 콘솔에 `js ...`로 출력
- 결과: `tools/preview/<테마><모드>-top|mid|bottom|collapsed.png` (git에 올리지 않음)
- 실행 전에 `tools/preview/profile`을 지워야 이전 테마 설정이 남지 않습니다.
- 가짜 데이터는 `preload.cjs`에 있습니다. 썸네일 이미지는 비어 있습니다.
