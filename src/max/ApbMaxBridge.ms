/*
ApbMaxBridge.ms  --  Aplaybox Downloader <-> 3ds Max 연동 (사용자 startup 스크립트 폴더에 설치됨)

Aplaybox Downloader 의 [3ds Max로 임포트] 가 이 스크립트를 Max 사용자 startup 폴더에 복사한다.
Max 가 켜져 있는 동안 1초마다 다음을 한다.
  1. %LOCALAPPDATA%\ApbDownloader\max-bridge\instances\<PID>.txt 에 PID·버전·씬 이름을 기록 (다운로더가 실행 중인 Max 목록을 만들 때 사용)
  2. requests\<PID>-*.txt 요청 파일이 있으면 읽고 지운 뒤, 다운로더에 내장된 ImportMMD.ms 를 열어 파일을 임포트
요청 파일 형식 (UTF-8): 1줄 ImportMMD.ms 경로, 2줄부터 임포트할 파일 경로.

제거: startup 폴더의 이 파일을 지우고 Max 를 다시 시작한다.
*/
global ApbBridge
global ImportMMD_DataDir
global ImportMMD_NoUI
global ImportMMD_ApbBridge
global ImportMMD_Rollout
global ImportMMDTool

(
	try ( if ApbBridge != undefined and ApbBridge.timer != undefined do ApbBridge.timer.Stop() ) catch ()
)

struct ApbBridgeStruct
(
	dir = "",
	pid = 0,
	year = 0,
	timer = undefined,
	busy = false,

	fn utf8 = dotNetObject "System.Text.UTF8Encoding" false,

	fn note msg =
	(
		try ( (dotNetClass "System.IO.File").AppendAllText (dir + "bridge_log.txt") ((localTime as string) + " [" + (pid as string) + "] " + msg + "\r\n") (utf8()) ) catch ()
	),

	fn beat state =
	(
		local scene = if maxFileName == "" then "" else maxFileName
		local txt = (pid as string) + "\t" + (year as string) + "\t" + state + "\t" + scene
		try ( (dotNetClass "System.IO.File").WriteAllText (dir + "instances\\" + (pid as string) + ".txt") txt (utf8()) ) catch ()
	),

	fn importerReady =
	(
		ImportMMD_ApbBridge == true and ImportMMD_Rollout != undefined and (try ( ImportMMD_Rollout.open ) catch ( false ))
	),

	fn handle reqFile =
	(
		local lines = (dotNetClass "System.IO.File").ReadAllLines reqFile (utf8())
		(dotNetClass "System.IO.File").Delete reqFile
		if lines.count < 2 do return false
		local importer = lines[1]
		local files = for i = 2 to lines.count where lines[i] != "" collect lines[i]
		note ("요청: 파일 " + (files.count as string) + "개")
		if not (importerReady()) do
		(
			if not (doesFileExist importer) do ( note ("ImportMMD.ms 없음: " + importer); return false )
			ImportMMD_DataDir = dir
			ImportMMD_NoUI = false
			ImportMMD_ApbBridge = undefined
			fileIn importer
		)
		if not (importerReady()) do ( note "임포트 창을 열지 못함"; return false )
		-- 다운로더 설정 창에서 바꾼 Blender / 반디집 경로를 반영한다 (다른 옵션은 임포트 창의 값을 유지)
		try
		(
			local t = ImportMMDTool
			t.blenderMode = (t.iniGet "BlenderMode" "1") as integer
			t.blenderPath = t.iniGet "BlenderPath" ""
			t.blenderInfo = t.iniGet "BlenderInfo" ""
			t.blenderVerified = t.iniGet "BlenderVerified" ""
			t.bzMode = (t.iniGet "BandizipMode" "1") as integer
			t.bzPath = t.iniGet "BandizipPath" ""
			ImportMMD_Rollout.settingsToUi()
		)
		catch ( note ("설정 다시 읽기 실패: " + (getCurrentException())) )
		try ( setFocus ImportMMD_Rollout ) catch ()
		ImportMMD_Rollout.enqueueAndRun files
		true
	),

	fn tick =
	(
		if busy do return ok
		busy = true
		try
		(
			beat "ready"
			local reqs = getFiles (dir + "requests\\" + (pid as string) + "-*.txt")
			sort reqs
			for r in reqs do
			(
				beat "busy"
				try ( handle r ) catch ( note ("오류: " + (getCurrentException())) )
				beat "ready"
			)
		)
		catch ( note ("tick 오류: " + (getCurrentException())) )
		busy = false
	),

	fn shutdown =
	(
		try ( timer.Stop() ) catch ()
		try ( deleteFile (dir + "instances\\" + (pid as string) + ".txt") ) catch ()
	),

	fn start =
	(
		dir = (systemTools.getEnvVariable "LOCALAPPDATA") + "\\ApbDownloader\\max-bridge\\"
		makeDir (dir + "instances") all:true
		makeDir (dir + "requests") all:true
		pid = ((dotNetClass "System.Diagnostics.Process").GetCurrentProcess()).Id
		year = 1998 + ((maxVersion())[1] / 1000)
		timer = dotNetObject "System.Windows.Forms.Timer"
		timer.Interval = 1000
		dotNet.addEventHandler timer "Tick" (fn apbBridgeTick s e = ( if ApbBridge != undefined do ApbBridge.tick() ))
		callbacks.removeScripts id:#ApbMaxBridge
		callbacks.addScript #preSystemShutdown "if ApbBridge != undefined do ApbBridge.shutdown()" id:#ApbMaxBridge
		beat "ready"
		timer.Start()
		note ("연동 시작 (Max " + (year as string) + ")")
	)
)

ApbBridge = ApbBridgeStruct()
ApbBridge.start()
