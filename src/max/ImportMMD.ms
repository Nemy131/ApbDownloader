/*
ImportMMD.ms  --  MMD 모델(.pmx / 압축 파일)을 3ds Max 2020 으로 일괄 임포트

사용법
  1. 이 파일과 pmx_to_fbx.py 를 같은 폴더에 둔다.
  2. Max 메뉴 Scripting > Run Script 로 이 파일을 실행한다 (뷰포트에 끌어다 놓아도 된다).
  3. [추가...] 로 .pmx / .zip / .rar / .7z 를 여러 개 고르고 [임포트 실행] 을 누른다.

처리 순서 (파일마다)
  압축 해제(반디집 bz.exe) -> .pmx 검색 -> Blender(mmd_tools)로 FBX 변환 -> FBX 임포트 -> 후처리
  한 파일이 실패해도 다음 파일로 넘어가고, 끝나면 요약을 보여준다.

만들어지는 파일
  <압축 파일과 같은 이름의 폴더>\          압축 해제 결과 (이미 있으면 재사용)
  <pmx 폴더>\_max_fbx\<이름>.fbx 외        변환 결과, 이름 대응표(.json), 매니페스트(.tsv), 로그
  <이 스크립트 폴더>\ImportMMD.ini         경로와 옵션 (압축 암호는 저장하지 않는다)
  <이 스크립트 폴더>\ImportMMD_log.txt     마지막 실행 로그

조정 가능한 상수 (아래 struct 의 기본값)
  blenderTimeoutSec   Blender 변환 1회 제한 시간(초)
  bzTimeoutSec        압축 해제 1회 제한 시간(초)
  probeTimeoutSec     Blender 검증 1회 제한 시간(초)
  outSubDir           변환 결과를 넣는 하위 폴더 이름

스크립트에서 UI 없이 쓰기
  global ImportMMD_NoUI = true
  fileIn "ImportMMD.ms"
  ImportMMDTool.runBatch #("D:\\a.zip", "D:\\b.pmx")
*/

global ImportMMD_NoUI
global ImportMMDTool
global ImportMMD_Rollout
global ImportMMD_DataDir      -- Aplaybox Downloader 연동: 설정·로그를 둘 폴더 (없으면 스크립트 폴더)
global ImportMMD_ApbBridge = true  -- 연동용 함수(enqueueAndRun)가 있는 버전 표시

-- PMX 하나의 변환·임포트 작업 (일괄 처리에서 Blender 변환을 동시에 돌리기 위한 기록)
struct ImportMMDTask
(
	src = "",              -- 사용자가 넣은 파일 (.pmx 또는 압축 파일)
	pmx = "",
	fbx = "", man = "", plog = "",
	keyFile = "", key = "",  -- 변환 결과 재사용 판단용
	state = #pending,      -- #pending > #running > #converted | #failed > #done
	proc = undefined, outTask = undefined, errTask = undefined,
	t0 = 0, killed = false, cached = false, why = ""
)

struct ImportMMDStruct
(
	-- ------------------------------------------------------------ 상수
	blenderTimeoutSec = 1800,
	bzTimeoutSec = 1800,
	probeTimeoutSec = 180,
	outSubDir = "_max_fbx",
	weldThreshold = 0.001,

	-- ------------------------------------------------------------ 경로
	scriptDir = "",
	pyScript = "",
	iniFile = "",
	logFile = "",

	-- ------------------------------------------------------------ 설정 (INI 에 저장)
	blenderMode = 1,        -- 1 자동 탐색, 2 직접 지정
	blenderPath = "",
	blenderInfo = "",
	blenderVerified = "",   -- 검증에 통과한 blender.exe 경로 (캐시)
	extraDirs = "",         -- 추가 검색 폴더, ; 로 구분
	bzMode = 1,             -- 1 자동 탐색, 2 직접 지정
	bzPath = "",
	keepMorphs = true,
	splitMode = 1,          -- 1 하나로 합치기, 2 재질별 분리
	matType = 1,            -- 1 Standard, 2 Physical
	scaleCm = 8.0,          -- MMD 1단위 = 몇 cm
	spacing = 30.0,         -- 모델 사이 간격 (시스템 단위)
	alphaMode = 1,          -- 알파가 있는 텍스처: 1 컷아웃, 2 반투명 Opacity, 3 사용 안 함
	restoreNames = true,    -- 임포트 후 원본(중국어/일본어) 이름 복원
	codePage = 1,           -- 1 GBK, 2 Shift-JIS, 3 UTF-8, 4 Big5, 5 시스템 기본
	forceExtract = false,
	multiPmx = 1,           -- 1 모두 변환, 2 가장 큰 파일만
	parallelBlender = 3,    -- 동시에 돌릴 Blender 변환 수 (1~8)
	reuseFbx = true,        -- PMX·옵션이 그대로면 이전 변환 결과(FBX)를 다시 쓴다
	password = "",          -- 저장하지 않음

	-- ------------------------------------------------------------ 실행 상태
	logLines = #(),
	results = #(),
	blenderReport = "",
	cancelRequested = false,
	progressFn = undefined,
	cursorX = undefined,
	tasks = #(),

	-- ------------------------------------------------------------ 기본 유틸
	fn logMsg msg =
	(
		append logLines (msg as string)
		format "[ImportMMD] %\n" msg
	),

	fn setProgress txt pct =
	(
		if progressFn != undefined do progressFn txt pct
	),

	fn isAsciiStr s =
	(
		local ok = true
		for i = 1 to s.count while ok do
			if (bit.charAsInt s[i]) > 127 do ok = false
		ok
	),

	fn quoted s = ("\"" + s + "\""),

	fn fileExists f =
	(
		(f != undefined) and (f != "") and ((dotNetClass "System.IO.File").Exists f)
	),

	fn dirExists d =
	(
		(d != undefined) and (d != "") and ((dotNetClass "System.IO.Directory").Exists d)
	),

	fn readLines f =
	(
		local res = #()
		try ( res = (dotNetClass "System.IO.File").ReadAllLines f ) catch ( res = #() )
		res
	),

	fn writeText f txt =
	(
		try ( (dotNetClass "System.IO.File").WriteAllText f txt ) catch ()
	),

	fn findFilesRecursive dir pattern =
	(
		local res = #()
		try
		(
			local opt = (dotNetClass "System.IO.SearchOption").AllDirectories
			res = (dotNetClass "System.IO.Directory").GetFiles dir pattern opt
		)
		catch ( res = #() )
		res
	),

	-- 출력 파일 이름: 원본 이름의 ASCII 문자 + 경로 해시 (경로가 같으면 항상 같은 이름)
	fn makeAsciiStem pmx =
	(
		local stem = getFilenameFile pmx
		local out = ""
		for i = 1 to stem.count do
		(
			local c = bit.charAsInt stem[i]
			if (c >= 48 and c <= 57) or (c >= 65 and c <= 90) or (c >= 97 and c <= 122) or c == 95 do
				out += stem[i]
		)
		if out.count > 32 do out = substring out 1 32
		if out.count == 0 do out = "mmd"
		local h = bit.and (getHashValue (toLower pmx) 17) 0xFFFFFF
		out + "_" + (formattedPrint h format:"06x")
	),

	-- ------------------------------------------------------------ 설정 저장/복원
	fn iniGet key def =
	(
		local v = getINISetting iniFile "ImportMMD" key
		if v == "" then def else v
	),

	fn loadSettings =
	(
		blenderMode = (iniGet "BlenderMode" "1") as integer
		blenderPath = iniGet "BlenderPath" ""
		blenderInfo = iniGet "BlenderInfo" ""
		blenderVerified = iniGet "BlenderVerified" ""
		extraDirs = iniGet "ExtraDirs" ""
		bzMode = (iniGet "BandizipMode" "1") as integer
		bzPath = iniGet "BandizipPath" ""
		keepMorphs = (iniGet "KeepMorphs" "true") == "true"
		splitMode = (iniGet "SplitMode" "1") as integer
		matType = (iniGet "MaterialType" "1") as integer
		scaleCm = (iniGet "ScaleCm" "8.0") as float
		spacing = (iniGet "Spacing" "30.0") as float
		-- 예전 설정(UseAlpha)에서 넘어오는 경우: 꺼져 있었으면 "사용 안 함"
		alphaMode = (iniGet "AlphaMode" (if (iniGet "UseAlpha" "true") == "true" then "1" else "3")) as integer
		restoreNames = (iniGet "RestoreNames" "true") == "true"
		codePage = (iniGet "CodePage" "1") as integer
		forceExtract = (iniGet "ForceExtract" "false") == "true"
		multiPmx = (iniGet "MultiPmx" "1") as integer
		parallelBlender = (iniGet "ParallelBlender" "3") as integer
		if parallelBlender < 1 do parallelBlender = 1
		if parallelBlender > 8 do parallelBlender = 8
		reuseFbx = (iniGet "ReuseFbx" "true") == "true"
	),

	fn saveSettings =
	(
		local pairs = #(
			#("BlenderMode", blenderMode as string), #("BlenderPath", blenderPath),
			#("BlenderInfo", blenderInfo), #("BlenderVerified", blenderVerified),
			#("ExtraDirs", extraDirs), #("BandizipMode", bzMode as string), #("BandizipPath", bzPath),
			#("KeepMorphs", keepMorphs as string), #("SplitMode", splitMode as string),
			#("MaterialType", matType as string), #("ScaleCm", scaleCm as string),
			#("Spacing", spacing as string), #("AlphaMode", alphaMode as string),
			#("RestoreNames", restoreNames as string), #("CodePage", codePage as string),
			#("ForceExtract", forceExtract as string), #("MultiPmx", multiPmx as string),
			#("ParallelBlender", parallelBlender as string), #("ReuseFbx", reuseFbx as string))
		for p in pairs do setINISetting iniFile "ImportMMD" p[1] p[2]
	),

	-- ------------------------------------------------------------ 외부 프로세스
	-- 반환: #(종료 코드, 표준 출력). 시간 초과/중단이면 종료 코드 -999
	fn runProcess exe args timeoutSec label =
	(
		local code = -1
		local outText = ""
		local psi = dotNetObject "System.Diagnostics.ProcessStartInfo"
		psi.FileName = exe
		psi.Arguments = args
		psi.UseShellExecute = false
		psi.CreateNoWindow = true
		psi.RedirectStandardInput = true     -- 암호 입력 등을 기다리며 멈추지 않도록 입력을 닫는다
		psi.RedirectStandardOutput = true
		psi.RedirectStandardError = true
		local p = dotNetObject "System.Diagnostics.Process"
		p.StartInfo = psi
		p.Start()
		local outTask = p.StandardOutput.ReadToEndAsync()
		local errTask = p.StandardError.ReadToEndAsync()
		try ( p.StandardInput.Close() ) catch ()
		local t0 = timeStamp()
		local killed = false
		while not p.HasExited do
		(
			sleep 0.1
			windows.processPostedMessages()
			local el = (timeStamp() - t0) / 1000.0
			setProgress (label + "  (" + ((el as integer) as string) + "초)") undefined
			if (not killed) and (cancelRequested or el > timeoutSec) do
			(
				killed = true
				try ( p.Kill() ) catch ()
			)
		)
		p.WaitForExit()
		code = if killed then -999 else p.ExitCode
		try ( outText = outTask.Result ) catch ( outText = "" )
		try ( outText += errTask.Result ) catch ()
		p.Dispose()
		#(code, outText)
	),

	-- ------------------------------------------------------------ Blender 탐색
	fn blenderVersionKey f =
	(
		local key = 0
		try
		(
			local vi = (dotNetClass "System.Diagnostics.FileVersionInfo").GetVersionInfo f
			key = vi.FileMajorPart * 10000 + vi.FileMinorPart * 100 + vi.FileBuildPart
		)
		catch ( key = 0 )
		key
	),

	fn addBlenderCandidate list f =
	(
		if fileExists f do
		(
			local dup = false
			for c in list where (toLower c) == (toLower f) do dup = true
			if not dup do append list f
		)
	),

	fn collectBlenderCandidates =
	(
		local list = #()
		local roots = #()
		for v in #("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432") do
		(
			local pf = systemTools.getEnvVariable v
			if pf != undefined do
			(
				append roots (pf + "\\Blender Foundation")
				append roots (pf + "\\Steam\\steamapps\\common")
			)
		)
		-- Steam 설치 경로
		try
		(
			local k = (dotNetClass "Microsoft.Win32.Registry").CurrentUser.OpenSubKey "Software\\Valve\\Steam"
			if k != undefined do
			(
				local sp = k.GetValue "SteamPath"
				if sp != undefined do append roots ((substituteString sp "/" "\\") + "\\steamapps\\common")
			)
		)
		catch ()
		-- 사용자 지정 추가 검색 폴더
		for d in (filterString extraDirs ";") do
		(
			local dd = trimRight (trimLeft d) " \\"
			if dd != "" do append roots dd
		)
		for r in roots where dirExists r do
		(
			addBlenderCandidate list (r + "\\blender.exe")
			for d in (getDirectories (r + "\\*")) do addBlenderCandidate list (d + "blender.exe")
		)
		-- .blend 파일 연결
		try
		(
			local k = (dotNetClass "Microsoft.Win32.Registry").ClassesRoot.OpenSubKey "blendfile\\shell\\open\\command"
			if k != undefined do
			(
				local cmd = k.GetValue ""
				if cmd != undefined do
				(
					local parts = filterString cmd "\""
					if parts.count > 0 do addBlenderCandidate list ((getFilenamePath parts[1]) + "blender.exe")
				)
			)
		)
		catch ()
		-- PATH
		local pathVar = systemTools.getEnvVariable "PATH"
		if pathVar != undefined do
			for d in (filterString pathVar ";") do
				addBlenderCandidate list ((trimRight d "\\") + "\\blender.exe")
		list
	),

	-- blender.exe 하나를 실제로 실행해 mmd_tools 사용 가능 여부를 확인. 반환: #(통과 여부, 설명)
	fn probeBlender exe =
	(
		local res = #(false, "실행 실패")
		local tmp = (getDir #temp) + "\\ImportMMD_probe.txt"
		try ( deleteFile tmp ) catch ()
		local args = "--background --python " + (quoted pyScript) + " -- --probe " + (quoted tmp)
		local r = runProcess exe args probeTimeoutSec ("Blender 검증: " + exe)
		if r[1] == -999 then res = #(false, "시간 초과 또는 중단")
		else
		(
			local lines = readLines tmp
			if lines.count > 0 then
			(
				local t = filterString lines[1] "\t" splitEmptyTokens:true
				if t.count >= 3 then
					res = #((t[1] == "OK"), ("Blender " + t[2] + " / " + t[3]))
				else res = #(false, lines[1])
			)
			else res = #(false, ("검증 결과 없음 (종료 코드 " + (r[1] as string) + ")"))
		)
		res
	),

	-- 사용할 Blender 를 정한다. force 가 true 면 캐시를 무시하고 다시 탐색/검증한다.
	fn resolveBlender force =
	(
		local ok = false
		blenderReport = ""
		if not (fileExists pyScript) then
			blenderReport = "pmx_to_fbx.py 를 찾을 수 없음: " + pyScript
		else if (not force) and (blenderPath != "") and (blenderVerified == blenderPath) and (fileExists blenderPath) then
		(
			ok = true
			blenderReport = "캐시된 경로 사용: " + blenderPath + "  [" + blenderInfo + "]"
		)
		else if blenderMode == 2 then
		(
			if not (fileExists blenderPath) then
				blenderReport = "지정한 blender.exe 가 없음: " + blenderPath
			else
			(
				local r = probeBlender blenderPath
				ok = r[1]
				blenderInfo = r[2]
				blenderVerified = if ok then blenderPath else ""
				blenderReport = (if ok then "통과: " else "탈락: ") + blenderPath + "  [" + r[2] + "]"
			)
		)
		else
		(
			local cands = collectBlenderCandidates()
			local keyed = for c in cands collect #(blenderVersionKey c, c)
			fn cmpDesc a b = ( b[1] - a[1] )
			qsort keyed cmpDesc
			if keyed.count == 0 do blenderReport = "설치된 Blender 를 찾지 못함"
			for k in keyed while (not ok) and (not cancelRequested) do
			(
				local r = probeBlender k[2]
				blenderReport += (if r[1] then "통과: " else "탈락: ") + k[2] + "  [" + r[2] + "]\n"
				if r[1] do
				(
					ok = true
					blenderPath = k[2]
					blenderInfo = r[2]
					blenderVerified = k[2]
				)
			)
			if not ok do
			(
				blenderVerified = ""
				blenderInfo = "사용 가능한 Blender 없음"
			)
		)
		logMsg ("Blender 확인 결과:\n" + blenderReport)
		saveSettings()
		ok
	),

	-- ------------------------------------------------------------ 반디집
	fn resolveBz =
	(
		local ok = false
		if bzMode == 2 then ok = fileExists bzPath
		else
		(
			local cands = #()
			for hive in #("LocalMachine", "CurrentUser") do
			(
				try
				(
					local root = getProperty (dotNetClass "Microsoft.Win32.Registry") hive
					local k = root.OpenSubKey "SOFTWARE\\Bandizip"
					if k != undefined do
					(
						local pf = k.GetValue "ProgramFolder"
						if pf != undefined do append cands ((trimRight pf "\\") + "\\bz.exe")
					)
				)
				catch ()
			)
			for v in #("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)") do
			(
				local pf = systemTools.getEnvVariable v
				if pf != undefined do append cands (pf + "\\Bandizip\\bz.exe")
			)
			for c in cands while not ok do
				if fileExists c do ( bzPath = c; ok = true )
		)
		ok
	),

	fn codePageSwitch =
	(
		case codePage of
		(
			1: "-cp:936 "
			2: "-cp:932 "
			3: "-cp:65001 "
			4: "-cp:950 "
			default: ""
		)
	),

	-- 압축 파일 하나를 같은 이름의 폴더에 푼다. 반환: #(성공 여부, 폴더 경로 또는 실패 원인)
	fn extractArchive arc =
	(
		local res = #(false, "")
		local dest = trimRight ((getFilenamePath arc) + (getFilenameFile arc)) " ."
		local marker = dest + "\\.importmmd_extracted"
		if (not forceExtract) and (fileExists marker) then
		(
			logMsg ("이미 해제된 폴더 재사용: " + dest)
			res = #(true, dest)
		)
		else
		(
			local args = "x -y -aoa " + (codePageSwitch())
			if password != "" do args += (quoted ("-p:" + password)) + " "
			args += (quoted ("-o:" + dest)) + " " + (quoted arc)
			local r = runProcess bzPath args bzTimeoutSec ("압축 해제: " + (filenameFromPath arc))
			if r[1] == 0 and (dirExists dest) then
			(
				writeText marker "ok"
				res = #(true, dest)
			)
			else
			(
				local why = "압축 해제 실패 (종료 코드 " + (r[1] as string) + ")"
				if r[1] == -999 do why = "압축 해제 시간 초과 또는 중단"
				if (findString r[2] "0xa0000020") != undefined do why = "암호가 필요한 압축 파일 (암호 미입력)"
				if (findString r[2] "0xa0000021") != undefined do why = "압축 암호가 틀림"
				if (findString r[2] "Unknown archive") != undefined do why = "압축 파일 형식을 알 수 없음"
				res = #(false, why)
			)
		)
		res
	),

	-- 압축 파일에서 변환할 .pmx 목록을 얻는다. 실패하면 예외를 던진다.
	fn collectPmxFromArchive arc =
	(
		if not (resolveBz()) do throw "반디집 bz.exe 를 찾을 수 없음"
		local r = extractArchive arc
		if not r[1] do throw r[2]
		local dest = r[2]
		-- 압축 안의 압축 (한 단계만)
		local inner = #()
		for pat in #("*.zip", "*.rar", "*.7z") do join inner (findFilesRecursive dest pat)
		for a in inner do
		(
			local ir = extractArchive a
			if not ir[1] do logMsg ("내부 압축 해제 실패: " + a + " : " + ir[2])
		)
		local pmxList = for f in (findFilesRecursive dest "*.pmx") where (toLower (getFilenameType f)) == ".pmx" collect f
		if pmxList.count > 1 and multiPmx == 2 do
		(
			local best = pmxList[1]
			for f in pmxList where (getFileSize f) > (getFileSize best) do best = f
			pmxList = #(best)
		)
		pmxList
	),

	-- ------------------------------------------------------------ 매니페스트
	-- 반환: #(모델 ID, 모델 원본 이름, 오브젝트 목록, 재질 목록, 모프 목록)
	fn readManifest f =
	(
		local man = #("", "", #(), #(), #())
		for line in (readLines f) do
		(
			local t = filterString line "\t" splitEmptyTokens:true
			if t.count >= 3 do
			(
				case t[1] of
				(
					"MODEL": ( man[1] = t[2]; man[2] = t[3] )
					"OBJ": append man[3] #(t[2], t[3])
					"MORPH": append man[5] #(t[2], t[3])
					"MAT":
					(
						if t.count >= 7 do
						(
							local c = filterString t[6] " "
							local col = color 204 204 204
							if c.count >= 3 do col = color ((c[1] as float) * 255) ((c[2] as float) * 255) ((c[3] as float) * 255)
							append man[4] #(t[2], t[3], t[4], (t[5] == "1"), col, (t[7] as float))
						)
					)
				)
			)
		)
		man
	),

	fn findRec recs nm =
	(
		local res = undefined
		local key = toLower nm
		for r in recs while res == undefined do
			if (toLower r[1]) == key do res = r
		res
	),

	-- 재질 하나를 만든다.
	--   알파 텍스처 + 컷아웃 모드: Physical Material 의 Cutout 맵을 쓴다. (Standard 재질에는 컷아웃이 없어 이 재질만 Physical 이 된다)
	--   알파 텍스처 + 반투명 모드: Standard 재질의 Opacity 맵을 쓴다.
	--   주의: Max 2020 뷰포트는 두 방식 모두 "투명 오브젝트"로 취급해 오브젝트 단위로만 정렬한다.
	--     그래서 어떤 재질이 알파를 쓰는지는 pmx_to_fbx.py 가 재질의 UV 영역 기준으로 좁게 판정한다.
	--   PMX 에서 불투명도가 1 미만인 재질: 항상 Standard 재질의 Opacity 값으로 처리한다.
	fn makeMaterial rec =
	(
		local nm = if restoreNames then rec[2] else rec[1]
		local tex = rec[3]
		local semi = rec[6] < 0.999
		local alphaTex = rec[4] and (tex != "") and (alphaMode != 3)
		local wantCutout = alphaTex and (not semi) and (alphaMode == 1 or matType == 2)
		local usePhysical = (not semi) and (matType == 2 or wantCutout)
		local m = undefined
		local dmap = undefined
		local omap = undefined
		if tex != "" do
		(
			dmap = Bitmaptexture name:(rec[1] + "_D") filename:tex
			dmap.alphaSource = 2          -- 디퓨즈에서는 알파를 쓰지 않음
			if alphaTex do
			(
				omap = Bitmaptexture name:(rec[1] + "_A") filename:tex
				omap.alphaSource = 0      -- 이미지 알파
				omap.monoOutput = 1       -- 알파를 흑백 출력으로
				omap.rgbOutput = 1
			)
		)
		if usePhysical then
		(
			m = PhysicalMaterial name:nm
			m.base_color = rec[5]
			m.roughness = 0.7
			if dmap != undefined do m.base_color_map = dmap
			if wantCutout and omap != undefined do m.cutout_map = omap
		)
		else
		(
			m = Standardmaterial name:nm
			m.ambient = rec[5]
			m.diffuse = rec[5]
			m.specularLevel = 0
			m.opacity = rec[6] * 100.0
			if dmap != undefined do m.diffuseMap = dmap
			if omap != undefined and alphaMode == 2 do m.opacityMap = omap
		)
		try ( showTextureMap m true ) catch ()
		m
	),

	-- ------------------------------------------------------------ FBX 임포트 + 후처리
	-- 반환: #(성공 여부, 설명)
	fn importFbx fbx manifestFile =
	(
		local res = #(false, "")
		local man = readManifest manifestFile
		local modelName = if man[2] != "" then man[2] else (getFilenameFile fbx)

		-- 경로에 비ASCII 문자가 있으면 임시 폴더의 ASCII 이름으로 복사해서 읽는다
		local src = fbx
		if not (isAsciiStr fbx) do
		(
			local tmp = (getDir #temp) + "\\ImportMMD_tmp.fbx"
			if isAsciiStr tmp do
			(
				try ( deleteFile tmp ) catch ()
				if (copyFile fbx tmp) do src = tmp
			)
		)

		local before = for o in objects collect o
		try ( pluginManager.loadClass FBXIMP ) catch ()
		FBXImporterSetParam "ResetImport"
		FBXImporterSetParam "Mode" #create
		FBXImporterSetParam "Skin" false
		FBXImporterSetParam "Shape" keepMorphs
		FBXImporterSetParam "Animation" false
		FBXImporterSetParam "FillTimeline" false
		FBXImporterSetParam "BakeAnimationLayers" false
		FBXImporterSetParam "Cameras" false
		FBXImporterSetParam "Lights" false
		FBXImporterSetParam "Markers" false
		FBXImporterSetParam "SmoothingGroups" true
		FBXImporterSetParam "ScaleConversion" true
		FBXImporterSetParam "UpAxis" #z
		FBXImporterSetParam "ImportBoneAsDummy" true

		local ok = false
		try ( ok = importFile src #noPrompt using:FBXIMP ) catch ( ok = false )
		if src != fbx do ( try ( deleteFile src ) catch () )
		local newNodes = for o in objects where (findItem before o) == 0 collect o

		if (not ok) or newNodes.count == 0 then
			res = #(false, "FBX 임포트 실패: " + fbx)
		else
		(
			-- 본/더미 등 지오메트리가 아닌 노드 삭제
			local geo = #()
			for o in newNodes where isValidNode o do
			(
				if (superClassOf o == GeometryClass) and (classOf o != BoneGeometry) then append geo o
				else delete o
			)

			-- Skin 삭제, 모프 유지가 꺼져 있으면 Morpher 도 삭제
			local morphChannels = 0
			for o in geo do
			(
				for i = o.modifiers.count to 1 by -1 do
				(
					local c = classOf o.modifiers[i]
					if c == Skin or ((not keepMorphs) and c == Morpher) do deleteModifier o i
				)
				for md in o.modifiers where (classOf md == Morpher) do
				(
					for ch = 1 to 100 do
					(
						if (WM3_MC_HasData md ch) do
						(
							morphChannels += 1
							if restoreNames do
							(
								local mr = findRec man[5] (WM3_MC_GetName md ch)
								if mr != undefined do WM3_MC_SetName md ch mr[2]
							)
						)
					)
				)
			)

			-- 재질 정리
			local made = #()       -- #(ascii 이름, 재질)
			local matched = 0
			local unmatched = 0
			fn resolveMat src man made &matched &unmatched owner =
			(
				local out = src
				if src != undefined do
				(
					local cached = undefined
					for m in made while cached == undefined do
						if m[1] == (toLower src.name) do cached = m[2]
					if cached != undefined then out = cached
					else
					(
						local rec = owner.findRec man[4] src.name
						if rec != undefined then
						(
							out = owner.makeMaterial rec
							append made #((toLower src.name), out)
							matched += 1
						)
						else unmatched += 1
					)
				)
				out
			)
			for o in geo do
			(
				local mat = o.material
				if classOf mat == Multimaterial then
				(
					for i = 1 to mat.numsubs do
						mat.materialList[i] = resolveMat mat.materialList[i] man made &matched &unmatched this
					if restoreNames do mat.name = modelName
				)
				else if mat != undefined do
					o.material = resolveMat mat man made &matched &unmatched this
			)

			-- 이름 복원
			if restoreNames do
				for o in geo do
				(
					local r = findRec man[3] o.name
					if r != undefined do o.name = r[2]
				)

			-- 레이어
			local lname = modelName
			local n = 2
			while (LayerManager.getLayerFromName lname) != undefined do
			(
				lname = modelName + "_" + (n as string)
				n += 1
			)
			local layer = LayerManager.newLayerFromName lname
			for o in geo do layer.addNode o

			-- X축 배치
			if geo.count > 0 do
			(
				local bmin = geo[1].min
				local bmax = geo[1].max
				for o in geo do
				(
					if o.min.x < bmin.x do bmin.x = o.min.x
					if o.max.x > bmax.x do bmax.x = o.max.x
				)
				local shift = 0.0
				if cursorX != undefined do shift = cursorX - bmin.x
				if shift != 0.0 do for o in geo do move o [shift, 0, 0]
				cursorX = bmax.x + shift + spacing
			)

			local msg = "오브젝트 " + (geo.count as string) + "개, 재질 " + (matched as string) + "개 연결"
			if unmatched > 0 do msg += " (" + (unmatched as string) + "개는 매니페스트에 없어 그대로 둠)"
			msg += ", 모프 채널 " + (morphChannels as string) + "개, 레이어 '" + lname + "'"
			if keepMorphs and man[5].count > morphChannels do
				msg += "  [주의: 변환된 모프는 " + (man[5].count as string) + "개인데 일부만 들어옴]"
			res = #(true, msg)
		)
		res
	),

	-- ------------------------------------------------------------ PMX 변환 작업 (Blender 를 여러 개 동시에)
	-- 같은 PMX 를 같은 옵션·같은 변환 스크립트로 바꾸면 같은 FBX 가 나오므로, 이 키가 같으면 이전 결과를 다시 쓴다.
	fn convertKey pmx =
	(
		local stamp = ""
		try ( stamp = ((dotNetClass "System.IO.File").GetLastWriteTimeUtc pmx).ToString "yyyyMMddHHmmss" ) catch ()
		local pyStamp = ""
		try ( pyStamp = ((dotNetClass "System.IO.File").GetLastWriteTimeUtc pyScript).ToString "yyyyMMddHHmmss" ) catch ()
		((getFileSize pmx) as string) + "|" + stamp + "|" + (keepMorphs as string) + "|" + (splitMode as string) + "|" + (formattedPrint scaleCm format:".4f") + "|" + pyStamp
	),

	fn makeTask src pmx =
	(
		local t = ImportMMDTask src:src pmx:pmx
		local outDir = (getFilenamePath pmx) + outSubDir
		makeDir outDir all:true
		local stem = makeAsciiStem pmx
		t.fbx = outDir + "\\" + stem + ".fbx"
		t.man = outDir + "\\" + stem + ".manifest.tsv"
		t.plog = outDir + "\\" + stem + ".log"
		t.keyFile = outDir + "\\" + stem + ".key.txt"
		t.key = convertKey pmx
		if reuseFbx and (fileExists t.fbx) and (fileExists t.man) and (fileExists t.keyFile) do
		(
			local lines = readLines t.keyFile
			if lines.count > 0 and lines[1] == t.key do
			(
				t.state = #converted
				t.cached = true
			)
		)
		t
	),

	-- Blender 를 띄우고 바로 돌아온다 (끝났는지는 pumpConverts 가 확인)
	fn startConvert t =
	(
		for f in #(t.fbx, t.man, t.plog, t.keyFile) do ( try ( deleteFile f ) catch () )
		local args = "--background --python " + (quoted pyScript) + " -- " + (quoted t.pmx) + " " + (quoted t.fbx)
		args += " --morphs " + (if keepMorphs then "1" else "0")
		args += " --split " + (if splitMode == 2 then "material" else "merge")
		args += " --scale " + (formattedPrint scaleCm format:".4f")
		args += " --log " + (quoted t.plog)
		try
		(
			local psi = dotNetObject "System.Diagnostics.ProcessStartInfo"
			psi.FileName = blenderPath
			psi.Arguments = args
			psi.UseShellExecute = false
			psi.CreateNoWindow = true
			psi.RedirectStandardInput = true
			psi.RedirectStandardOutput = true
			psi.RedirectStandardError = true
			local p = dotNetObject "System.Diagnostics.Process"
			p.StartInfo = psi
			p.Start()
			t.outTask = p.StandardOutput.ReadToEndAsync()
			t.errTask = p.StandardError.ReadToEndAsync()
			try ( p.StandardInput.Close() ) catch ()
			t.proc = p
			t.t0 = timeStamp()
			t.killed = false
			t.state = #running
		)
		catch
		(
			t.why = "Blender 실행 실패: " + (getCurrentException())
			t.state = #failed
		)
	),

	fn finishConvert t =
	(
		local code = -1
		try
		(
			t.proc.WaitForExit()
			code = t.proc.ExitCode
		)
		catch ()
		if t.killed do code = -999
		try ( t.proc.Dispose() ) catch ()
		t.proc = undefined
		t.outTask = undefined
		t.errTask = undefined
		if code != 0 or not (fileExists t.fbx) then
		(
			local why = "Blender 변환 실패 (종료 코드 " + (code as string) + ")"
			if code == -999 do why = "Blender 변환 시간 초과 또는 중단"
			for line in (readLines t.plog) do
				if (findString line "PMX2FBX_ERROR:") != undefined do why = line
			t.why = why
			t.state = #failed
		)
		else
		(
			writeText t.keyFile t.key
			t.state = #converted
		)
	),

	-- 끝난 변환을 정리하고, 빈 자리만큼 대기 중인 변환을 시작한다. 반환: 진행 중인 변환 수
	fn pumpConverts =
	(
		local active = 0
		for t in tasks do
		(
			if t.state == #running do
			(
				local exited = true
				try ( exited = t.proc.HasExited ) catch ( exited = true )
				if exited then finishConvert t
				else
				(
					if (not t.killed) and ((timeStamp() - t.t0) / 1000.0) > blenderTimeoutSec do
					(
						t.killed = true
						try ( t.proc.Kill() ) catch ()
					)
					active += 1
				)
			)
		)
		for t in tasks do
		(
			if t.state == #pending and active < parallelBlender do
			(
				startConvert t
				if t.state == #running do active += 1
			)
		)
		active
	),

	fn killConverts =
	(
		for t in tasks do
		(
			if t.state == #running do
			(
				try ( t.proc.Kill() ) catch ()
				try ( t.proc.Dispose() ) catch ()
				t.proc = undefined
				t.why = "중단됨"
				t.state = #failed
			)
		)
	),

	-- ------------------------------------------------------------ 일괄 처리
	fn addResult src pmx ok msg =
	(
		msg = substituteString (msg as string) "-- Runtime error: " ""
		append results #(src, pmx, ok, msg)
		-- Aplaybox Downloader 연동: 파일별 결과를 연동 폴더의 results 에 남긴다 (다운로더의 [임포트 완료] 탭이 읽고 지운다)
		if classOf ImportMMD_DataDir == String and ImportMMD_DataDir != "" do
		(
			try
			(
				local rdir = ImportMMD_DataDir
				if not (matchPattern rdir pattern:"*\\") do rdir += "\\"
				rdir += "results\\"
				makeDir rdir all:true
				local stamp = ((dotNetClass "System.DateTime").Now).ToString "yyyyMMddHHmmssfffffff"
				local line = (if ok then "ok" else "fail") + "\t" + (src as string) + "\t" + (pmx as string) + "\t" + (substituteString (substituteString msg "\n" " ") "\t" " ")
				(dotNetClass "System.IO.File").WriteAllText (rdir + stamp + "-" + (results.count as string) + ".txt") line (dotNetObject "System.Text.UTF8Encoding" false)
			)
			catch ()
		)
		logMsg ((if ok then "[성공] " else "[실패] ") + (filenameFromPath src) + (if pmx != "" and pmx != src then (" > " + (filenameFromPath pmx)) else "") + " : " + msg)
	),

	fn summaryText =
	(
		local okCount = 0
		for r in results where r[3] do okCount += 1
		local s = "성공 " + (okCount as string) + " / 실패 " + ((results.count - okCount) as string) + "\n"
		for r in results do
		(
			s += (if r[3] then "[성공] " else "[실패] ") + (filenameFromPath r[1])
			if r[2] != "" and r[2] != r[1] do s += " > " + (filenameFromPath r[2])
			s += "\n    " + r[4] + "\n"
		)
		s
	),

	fn runBatch files =
	(
		logLines = #()
		results = #()
		cancelRequested = false
		-- 씬에 이미 지오메트리가 있으면 그 오른쪽부터 배치한다
		cursorX = undefined
		for o in geometry do
			if cursorX == undefined or (o.max.x + spacing) > cursorX do cursorX = o.max.x + spacing
		logMsg ("시작: " + localTime + " / 파일 " + (files.count as string) + "개")

		setProgress "Blender 확인 중..." 0
		if not (resolveBlender false) then
			addResult "(Blender)" "" false ("mmd_tools 를 쓸 수 있는 Blender 를 찾지 못해 시작하지 않음.\n" + blenderReport)
		else
		(
			tasks = #()
			-- 1) 파일 순서대로 압축을 풀어 PMX 목록을 만든다. PMX 가 나오는 대로 Blender 변환을 미리 시작한다.
			for i = 1 to files.count while not cancelRequested do
			(
				local f = files[i]
				setProgress ("[" + (i as string) + "/" + (files.count as string) + "] 준비: " + (filenameFromPath f)) (20.0 * (i - 1) / files.count)
				try
				(
					if not (fileExists f) do throw "파일이 없음"
					local pmxList = #()
					if (toLower (getFilenameType f)) == ".pmx" then pmxList = #(f)
					else pmxList = collectPmxFromArchive f
					if pmxList.count == 0 then addResult f "" false "압축 파일 안에 .pmx 가 없음"
					else
						for pmx in pmxList do append tasks (makeTask f pmx)
				)
				catch ( addResult f "" false (getCurrentException()) )
				pumpConverts()
			)
			-- 2) 변환이 끝난 것부터 파일 순서대로 임포트한다. 임포트하는 동안에도 나머지 변환은 계속 진행된다.
			local nextIdx = 1
			local tStart = timeStamp()
			while nextIdx <= tasks.count and not cancelRequested do
			(
				local active = pumpConverts()
				local t = tasks[nextIdx]
				local pct = 20.0 + 80.0 * (nextIdx - 1) / tasks.count
				if t.state == #converted then
				(
					setProgress ("[" + (nextIdx as string) + "/" + (tasks.count as string) + "] FBX 임포트: " + (filenameFromPath t.pmx)) pct
					local r = #(false, "")
					try ( with redraw off ( r = importFbx t.fbx t.man ) )
					catch ( r = #(false, getCurrentException()) )
					if r[1] and t.cached do r[2] += " (이전 변환 결과 재사용)"
					addResult t.src t.pmx r[1] r[2]
					t.state = #done
					nextIdx += 1
				)
				else if t.state == #failed then
				(
					addResult t.src t.pmx false t.why
					t.state = #done
					nextIdx += 1
				)
				else
				(
					sleep 0.1
					windows.processPostedMessages()
					local el = ((timeStamp() - tStart) / 1000.0) as integer
					setProgress ("[" + (nextIdx as string) + "/" + (tasks.count as string) + "] Blender 변환 중 " + (active as string) + "개: " + (filenameFromPath t.pmx) + "  (" + (el as string) + "초)") pct
				)
			)
			if cancelRequested do
			(
				killConverts()
				for t in tasks do
					if t.state != #done do addResult t.src t.pmx false "사용자가 중단함"
				logMsg "사용자가 중단함"
			)
			tasks = #()
		)
		try ( redrawViews() ) catch ()
		local summary = summaryText()
		logMsg ("요약:\n" + summary)
		local txt = ""
		for l in logLines do txt += (substituteString l "\n" "\r\n") + "\r\n"
		writeText logFile txt
		setProgress "완료" 100
		summary
	),

	-- ------------------------------------------------------------ 후처리
	-- 스택 최상단에 Edit Poly 를 올리고 Quadrify All > 보더 전체 선택 >
	-- 버텍스 선택으로 변환 > Weld 를 수행한다. Edit Poly 의 조작은 Modify 패널에서
	-- 해당 모디파이어가 현재 항목일 때만 동작하므로 오브젝트를 하나씩 선택해 처리한다.
	-- 반환: #(처리 전 버텍스, 처리 전 면, 처리 후 버텍스, 처리 후 면, 보더 에지 수)
	fn quadWeldNode obj =
	(
		local ep = Edit_Poly()
		addModifier obj ep
		select obj
		modPanel.setCurrentObject ep node:obj
		local v0 = ep.GetNumVertices()
		local f0 = ep.GetNumFaces()
		subobjectLevel = 4
		PolyToolsModeling.Quadrify false false
		subobjectLevel = 3
		ep.SetSelection #Edge #{}
		max select all
		local nBorder = (ep.GetSelection #Edge).numberset
		if nBorder > 0 do
		(
			ep.ConvertSelection #Border #Vertex
			subobjectLevel = 1
			ep.weldVertexThreshold = weldThreshold
			ep.ButtonOp #WeldVertex
		)
		subobjectLevel = 0
		#(v0, f0, ep.GetNumVertices(), ep.GetNumFaces(), nBorder)
	),

	fn quadWeldSelection =
	(
		local objs = for o in selection where superclassof o == GeometryClass collect o
		if objs.count == 0 do return "선택된 지오메트리 오브젝트가 없습니다."
		local txt = ""
		local okCount = 0
		max modify mode
		for i = 1 to objs.count do
		(
			local o = objs[i]
			setProgress ("Quadrify + Weld: " + o.name) (100.0 * (i - 1) / objs.count)
			try
			(
				local r = quadWeldNode o
				okCount += 1
				txt += "[성공] " + o.name + " : 버텍스 " + r[1] as string + " > " + r[3] as string + ", 면 " + r[2] as string + " > " + r[4] as string + ", 보더 에지 " + r[5] as string + "\n"
			)
			catch
			(
				txt += "[실패] " + o.name + " : " + (substituteString (getCurrentException()) "-- Runtime error: " "") + "\n"
			)
		)
		try ( subobjectLevel = 0 ) catch ()
		select objs
		setProgress "완료" 100
		"Quadrify + Weld (Threshold " + weldThreshold as string + ") : 성공 " + okCount as string + " / 실패 " + (objs.count - okCount) as string + "\n" + txt
	),

	fn init =
	(
		scriptDir =getFilenamePath (getThisScriptFilename())
		pyScript = scriptDir + "pmx_to_fbx.py"
		-- Aplaybox Downloader 에서 불러온 경우 설정·로그는 앱 업데이트와 무관한 연동 폴더에 둔다
		local dataDir = scriptDir
		if classOf ImportMMD_DataDir == String and ImportMMD_DataDir != "" do
		(
			dataDir = ImportMMD_DataDir
			if not (matchPattern dataDir pattern:"*\\") do dataDir += "\\"
			makeDir dataDir all:true
		)
		iniFile = dataDir + "ImportMMD.ini"
		logFile = dataDir + "ImportMMD_log.txt"
		loadSettings()
	)
)

ImportMMDTool = ImportMMDStruct()
ImportMMDTool.init()

-- ==================================================================== UI
try ( destroyDialog ImportMMD_Rollout ) catch ()

rollout ImportMMD_Rollout "MMD 모델 임포트 (PMX > Blender > FBX)" width:470
(
	local fileList = #()
	local running = false
	local pendingRun = false

	group "파일 목록 (.pmx / .zip / .rar / .7z)"
	(
		multiListBox lbxFiles "" height:7
		button btnAdd "추가..." width:100 across:3
		button btnRemove "선택 제거" width:100
		button btnClear "전체 비우기" width:100
	)
	group "변환 옵션"
	(
		checkbox chkMorphs "모프(표정) 유지" across:2
		checkbox chkRestore "원본 이름 복원 (중국어/일본어)"
		radiobuttons rdoSplit "메시:" labels:#("하나로 합치기", "재질별 분리") columns:2 align:#left
		radiobuttons rdoMat "재질:" labels:#("Standard", "Physical Material") columns:2 align:#left
		dropdownlist ddlAlpha "알파가 있는 텍스처:" items:#("컷아웃 (해당 재질은 Physical Material)", "반투명 Opacity (Standard 재질)", "사용 안 함")
		spinner spnScale "스케일 (MMD 1단위 = cm): " range:[0.001, 10000, 8] type:#float fieldWidth:60 across:2 align:#left
		spinner spnSpacing "모델 간격: " range:[0, 100000, 30] type:#float fieldWidth:60 align:#right
		spinner spnParallel "동시 변환 (Blender 개수): " range:[1, 8, 3] type:#integer fieldWidth:40 across:2 align:#left
		checkbox chkReuse "이전 변환 결과 재사용" align:#right
	)
	group "압축 파일"
	(
		dropdownlist ddlCp "파일명 코드페이지:" items:#("GBK (중국어 간체)", "Shift-JIS (일본어)", "UTF-8", "Big5 (중국어 번체)", "시스템 기본")
		edittext edtPw "암호 (저장 안 함): " fieldWidth:300
		checkbox chkForce "이미 해제된 폴더가 있어도 다시 해제"
		radiobuttons rdoMulti "PMX 가 여러 개일 때:" labels:#("모두 변환", "가장 큰 파일만") columns:2 align:#left
	)
	group "Blender (mmd_tools 필요)"
	(
		radiobuttons rdoBlender "" labels:#("자동 탐색", "직접 지정") columns:2 align:#left
		edittext edtBlender "" readOnly:true
		button btnBlenderBrowse "찾아보기..." width:100 across:2
		button btnBlenderRescan "다시 탐색 / 검증" width:130
		label lblBlender "" align:#left
		edittext edtExtra "추가 검색 폴더(;): "
	)
	group "반디집 (bz.exe)"
	(
		radiobuttons rdoBz "" labels:#("자동 탐색", "직접 지정") columns:2 align:#left
		edittext edtBz "" readOnly:true
		button btnBzBrowse "찾아보기..." width:100
	)
	group "후처리 (선택한 오브젝트)"
	(
		button btnQuadWeld "Edit Poly: Quadrify All + 보더 버텍스 Weld (0.001)" width:430 tooltip:"스택 최상단에 Edit Poly 추가 > Quadrify All > 보더 전체 선택 > 버텍스 선택으로 변환 > Weld Threshold 0.001"
	)
	progressBar pbMain height:12
	label lblStatus "대기 중" align:#left
	button btnRun "임포트 실행" width:200 height:30 across:2
	button btnCancel "중단" width:100 height:30 enabled:false
	edittext edtLog "" height:110 readOnly:true

	fn refreshList =
	(
		lbxFiles.items = for f in fileList collect (filenameFromPath f)
		lbxFiles.selection = #{}
	)

	fn settingsToUi =
	(
		local t = ImportMMDTool
		chkMorphs.checked = t.keepMorphs
		chkRestore.checked = t.restoreNames
		rdoSplit.state = t.splitMode
		rdoMat.state = t.matType
		ddlAlpha.selection = t.alphaMode
		spnScale.value = t.scaleCm
		spnSpacing.value = t.spacing
		ddlCp.selection = t.codePage
		chkForce.checked = t.forceExtract
		rdoMulti.state = t.multiPmx
		spnParallel.value = t.parallelBlender
		chkReuse.checked = t.reuseFbx
		rdoBlender.state = t.blenderMode
		edtBlender.text = t.blenderPath
		lblBlender.text = if t.blenderVerified != "" and t.blenderVerified == t.blenderPath then t.blenderInfo else "아직 검증 안 됨 (실행할 때 자동으로 확인)"
		edtExtra.text = t.extraDirs
		rdoBz.state = t.bzMode
		if t.bzMode == 1 do t.resolveBz()
		edtBz.text = t.bzPath
		btnBlenderBrowse.enabled = (t.blenderMode == 2)
		btnBzBrowse.enabled = (t.bzMode == 2)
	)

	fn uiToSettings =
	(
		local t = ImportMMDTool
		t.keepMorphs = chkMorphs.checked
		t.restoreNames = chkRestore.checked
		t.splitMode = rdoSplit.state
		t.matType = rdoMat.state
		t.alphaMode = ddlAlpha.selection
		t.scaleCm = spnScale.value
		t.spacing = spnSpacing.value
		t.codePage = ddlCp.selection
		t.password = edtPw.text
		t.forceExtract = chkForce.checked
		t.multiPmx = rdoMulti.state
		t.parallelBlender = spnParallel.value
		t.reuseFbx = chkReuse.checked
		t.blenderMode = rdoBlender.state
		t.extraDirs = edtExtra.text
		t.bzMode = rdoBz.state
		t.saveSettings()
	)

	fn onProgress txt pct =
	(
		lblStatus.text = txt
		if pct != undefined do pbMain.value = pct
	)

	fn setBusy busy =
	(
		btnRun.enabled = not busy
		btnCancel.enabled = busy
		btnAdd.enabled = not busy
		btnRemove.enabled = not busy
		btnClear.enabled = not busy
		btnBlenderRescan.enabled = not busy
		btnQuadWeld.enabled = not busy
	)

	on ImportMMD_Rollout open do
	(
		ImportMMDTool.progressFn = onProgress
		settingsToUi()
	)

	on ImportMMD_Rollout close do
	(
		uiToSettings()
		ImportMMDTool.cancelRequested = true
		ImportMMDTool.progressFn = undefined
	)

	on btnAdd pressed do
	(
		local dlg = dotNetObject "System.Windows.Forms.OpenFileDialog"
		dlg.Title = "MMD 모델 또는 압축 파일 선택 (여러 개 선택 가능)"
		dlg.Multiselect = true
		dlg.Filter = "MMD 모델 / 압축 파일 (*.pmx;*.zip;*.rar;*.7z)|*.pmx;*.zip;*.rar;*.7z|모든 파일 (*.*)|*.*"
		local last = getINISetting ImportMMDTool.iniFile "ImportMMD" "LastDir"
		if last != "" and (ImportMMDTool.dirExists last) do dlg.InitialDirectory = last
		local dr = dlg.ShowDialog()
		if dr.Equals dr.OK do
		(
			local picked = dlg.FileNames
			for f in picked do
			(
				local dup = false
				for e in fileList where (toLower e) == (toLower f) do dup = true
				if not dup do append fileList f
			)
			if picked.count > 0 do setINISetting ImportMMDTool.iniFile "ImportMMD" "LastDir" (getFilenamePath picked[1])
			refreshList()
		)
		dlg.Dispose()
	)

	on btnRemove pressed do
	(
		local sel = lbxFiles.selection
		fileList = for i = 1 to fileList.count where not sel[i] collect fileList[i]
		refreshList()
	)

	on btnClear pressed do
	(
		fileList = #()
		refreshList()
	)

	on rdoBlender changed st do
	(
		btnBlenderBrowse.enabled = (st == 2)
		ImportMMDTool.blenderMode = st
	)

	on rdoBz changed st do
	(
		btnBzBrowse.enabled = (st == 2)
		ImportMMDTool.bzMode = st
		if st == 1 do ( ImportMMDTool.resolveBz(); edtBz.text = ImportMMDTool.bzPath )
	)

	on btnBlenderBrowse pressed do
	(
		local f = getOpenFileName caption:"blender.exe 선택" types:"blender.exe|blender.exe|실행 파일 (*.exe)|*.exe|"
		if f != undefined do
		(
			uiToSettings()
			ImportMMDTool.blenderPath = f
			ImportMMDTool.blenderMode = 2
			setBusy true
			ImportMMDTool.cancelRequested = false
			local ok = ImportMMDTool.resolveBlender true
			setBusy false
			settingsToUi()
			lblStatus.text = if ok then "Blender 검증 통과" else "Blender 검증 실패"
			edtLog.text = ImportMMDTool.blenderReport
		)
	)

	on btnBlenderRescan pressed do
	(
		uiToSettings()
		setBusy true
		ImportMMDTool.cancelRequested = false
		local ok = ImportMMDTool.resolveBlender true
		setBusy false
		settingsToUi()
		lblStatus.text = if ok then "Blender 확인 완료" else "사용할 수 있는 Blender 를 찾지 못함"
		edtLog.text = ImportMMDTool.blenderReport
	)

	on btnBzBrowse pressed do
	(
		local f = getOpenFileName caption:"bz.exe 선택" types:"bz.exe|bz.exe|실행 파일 (*.exe)|*.exe|"
		if f != undefined do
		(
			ImportMMDTool.bzPath = f
			ImportMMDTool.bzMode = 2
			edtBz.text = f
			ImportMMDTool.saveSettings()
		)
	)

	on btnQuadWeld pressed do
	(
		setBusy true
		local summary = ""
		try ( summary = ImportMMDTool.quadWeldSelection() )
		catch ( summary = "예기치 않은 오류: " + (getCurrentException()) )
		setBusy false
		btnCancel.enabled = false
		edtLog.text = substituteString summary "\n" "\r\n"
		lblStatus.text = "Quadrify + Weld 완료"
	)

	on btnCancel pressed do
	(
		ImportMMDTool.cancelRequested = true
		lblStatus.text = "중단 요청됨..."
	)

	-- 목록 전체를 임포트한다. 실행 중에 Aplaybox Downloader 에서 파일이 더 들어오면 끝난 뒤 이어서 처리한다.
	fn runNow quiet:false =
	(
		if running then ( pendingRun = true; return false )
		running = true
		do
		(
			pendingRun = false
			local batch = deepCopy fileList
			uiToSettings()
			setBusy true
			edtLog.text = ""
			local summary = ""
			try ( summary = ImportMMDTool.runBatch batch )
			catch ( summary = "예기치 않은 오류: " + (getCurrentException()) )
			-- 처리한 파일은 목록에서 빼고, 실행 중에 새로 들어온 파일만 남긴다
			fileList = for f in fileList where (findItem batch f) == 0 collect f
			refreshList()
			setBusy false
			settingsToUi()
			edtLog.text = summary
			-- 다운로더 요청(quiet)은 결과 창을 띄우지 않는다: 창이 열려 있는 동안 다음 요청이 막히기 때문
			if quiet then lblStatus.text = "완료 - 결과는 아래 로그 참고"
			else messageBox (summary + "\n로그: " + ImportMMDTool.logFile) title:"MMD 임포트 결과"
		)
		while pendingRun and fileList.count > 0
		running = false
		true
	)

	-- Aplaybox Downloader 연동: 파일을 목록에 추가하고 바로 임포트한다.
	fn enqueueAndRun files =
	(
		-- 다운로더의 임포트 창에서 정한 옵션(INI)을 다시 읽어 창에 반영한다. 임포트가 진행 중이면 현재 작업의 옵션을 바꾸지 않는다.
		if not running do
		(
			try ( ImportMMDTool.loadSettings(); settingsToUi() ) catch ()
		)
		for f in files do
		(
			local dup = false
			for e in fileList where (toLower e) == (toLower f) do dup = true
			if not dup do append fileList f
		)
		refreshList()
		if fileList.count > 0 do runNow quiet:true
	)

	on btnRun pressed do
	(
		if fileList.count == 0 then messageBox "먼저 [추가...] 로 파일을 선택하세요." title:"MMD 임포트"
		else runNow()
	)
)

if ImportMMD_NoUI != true do createDialog ImportMMD_Rollout
