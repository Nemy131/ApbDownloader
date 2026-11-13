# -*- coding: utf-8 -*-
"""
pmx_to_fbx.py  --  MMD 모델(.pmx)을 3ds Max용 FBX로 변환 (Blender 백그라운드 실행용)

사용법
  변환:
    blender --background --python pmx_to_fbx.py -- <입력.pmx> <출력.fbx> [옵션]
  Blender/mmd_tools 사용 가능 여부 검사 (ImportMMD.ms 의 자동 탐색이 사용):
    blender --background --python pmx_to_fbx.py -- --probe <결과파일.txt>

옵션
  --morphs 1|0          모프(셰이프 키) 유지 여부. 기본 1
  --split merge|material  메시를 하나로 합치기 / 재질별 분리. 기본 merge
  --scale <float>       MMD 1단위가 몇 cm 인지. 기본 8.0 (MMD 표준: 1단위 = 약 8cm)
  --log <파일>          로그를 파일로도 저장

산출물 (출력.fbx 옆에 생성)
  <이름>.fbx            바이너리 FBX 7.4, 메시만, Z-up, 단위 cm
  <이름>.json           원본 이름 <-> ASCII 이름 대응표와 변환 통계
  <이름>.manifest.tsv   ImportMMD.ms 가 읽는 재질/텍스처/이름 목록 (UTF-8, 탭 구분)
  <이름>_tex\           파일명이 비ASCII 인 텍스처의 ASCII 이름 복사본 (필요할 때만)

종료 코드
  0 성공 / 1 실패 (원인은 표준 출력의 "PMX2FBX_ERROR:" 줄과 로그 파일에 남는다)

요구 사항
  PMX 임포트 오퍼레이터(bpy.ops.mmd_tools.import_model 또는 bpy.ops.mmd_tools_local.import_model)가 있어야 한다.
  단독 mmd_tools 애드온, 또는 Cats Blender Plugin 에 포함된 mmd_tools 둘 다 지원한다.
"""
import bpy
import sys
import os
import re
import json
import shutil
import argparse
import traceback

# ---------------------------------------------------------------- 조정 가능한 상수
DEFAULT_SCALE_CM = 8.0        # MMD 1단위 = 8cm
EMPTY_MORPH_EPSILON = 1e-5    # 이 값(cm)보다 변위가 작은 셰이프 키는 빈 모프로 보고 제거
ALPHA_THRESHOLD = 0.99        # 알파 최소값이 이보다 작으면 "알파 있음"으로 판정
ALPHA_MIN_RATIO = 0.002       # 재질이 쓰는 UV 영역에서 반투명 픽셀 비율이 이보다 작으면 불투명 재질로 판정
UV_ALPHA_SAMPLES = 300000     # 재질 하나의 알파 판정에 쓰는 UV 표본 수 (면적에 비례해 배분)
FBX_SMOOTH_TYPE = 'FACE'      # 'OFF' | 'FACE' | 'EDGE'

# 자주 쓰이는 MMD 표준 모프 이름 (영문 이름이 없을 때 사용)
MORPH_DICT = {
    'まばたき': 'Blink', '笑い': 'Smile', 'ウィンク': 'Wink', 'ウィンク右': 'Wink_R',
    'ウィンク２': 'Wink2', 'ｳｨﾝｸ２右': 'Wink2_R', 'なごみ': 'Calm', 'はぅ': 'Hau',
    'びっくり': 'Surprise', 'じと目': 'Jito', 'ｷﾘｯ': 'Kiri', 'はちゅ目': 'Hachume',
    '星目': 'StarEye', 'はぁと': 'HeartEye', '瞳小': 'PupilSmall', '瞳大': 'PupilBig',
    'あ': 'A', 'い': 'I', 'う': 'U', 'え': 'E', 'お': 'O', 'あ２': 'A2', 'ん': 'N',
    '▲': 'MouthTri', '∧': 'MouthHat', '□': 'MouthBox', 'ワ': 'Wa', 'ω': 'Omega',
    'ω□': 'OmegaBox', 'にやり': 'Grin', 'にやり２': 'Grin2', 'にっこり': 'Nikkori',
    'ぺろっ': 'Tongue', 'てへぺろ': 'Tehepero', '口角上げ': 'MouthUp', '口角下げ': 'MouthDown',
    '口横広げ': 'MouthWide', '真面目': 'Serious', '困る': 'Troubled', 'にこり': 'Cheerful',
    '怒り': 'Angry', '上': 'BrowUp', '下': 'BrowDown', '照れ': 'Blush', '涙': 'Tears',
    '眨眼': 'Blink', '笑': 'Smile', '啊': 'A', '张嘴': 'MouthOpen', '闭眼': 'EyeClose',
    '生气': 'Angry', '惊讶': 'Surprise', '脸红': 'Blush', '眼泪': 'Tears',
}

_LOG = []


def log(msg):
    line = '[pmx_to_fbx] ' + str(msg)
    _LOG.append(line)
    try:
        print(line)
    except Exception:
        print(line.encode('ascii', 'backslashreplace').decode('ascii'))
    sys.stdout.flush()


def write_text(path, text):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


# ---------------------------------------------------------------- mmd_tools 확인
# PMX 임포트 오퍼레이터가 등록되는 네임스페이스.
#   mmd_tools        단독 MMD Tools 애드온, 구버전 Cats 에 포함된 것
#   mmd_tools_local  최신 Cats (Blender 4.x / 5.x 용) 에 포함된 것
IMPORT_OP_NAMESPACES = ('mmd_tools', 'mmd_tools_local')
_IMPORT_OP = None   # (네임스페이스, 오퍼레이터)


def import_op_props():
    """PMX 임포트 오퍼레이터의 인자 이름 집합. 없으면 None."""
    global _IMPORT_OP
    for ns in IMPORT_OP_NAMESPACES:
        try:
            op = getattr(getattr(bpy.ops, ns), 'import_model')
            rna = op.get_rna_type()
            _IMPORT_OP = (ns, op)
            return {p.identifier for p in rna.properties}
        except Exception:
            continue
    _IMPORT_OP = None
    return None


def ensure_mmd_tools():
    """오퍼레이터가 없으면 mmd_tools / cats 계열 애드온 활성화를 시도한다.
    반환: (props 또는 None, 설명 문자열)"""
    import addon_utils
    props = import_op_props()
    tried = []
    if props is None:
        names = []
        for m in addon_utils.modules():
            n = m.__name__
            low = n.lower()
            if 'mmd_tools' in low or 'mmd-tools' in low or 'cats' in low:
                names.append(n)
        # 단독 mmd_tools 를 먼저 시도
        names.sort(key=lambda n: (0 if 'mmd' in n.lower() else 1, n))
        for n in names:
            try:
                addon_utils.enable(n, default_set=False)
                tried.append(n)
            except Exception as e:
                tried.append('%s(실패: %r)' % (n, e))
            props = import_op_props()
            if props is not None:
                break
    if props is None:
        if tried:
            return None, 'mmd_tools 임포트 오퍼레이터 없음 (활성화 시도: %s)' % ', '.join(tried)
        return None, 'mmd_tools 또는 Cats 애드온이 설치되어 있지 않음'
    ns = _IMPORT_OP[0]
    src = 'bpy.ops.%s.import_model' % ns
    try:
        cls = getattr(bpy.types, ns.upper() + '_OT_import_model', None)
        if cls is not None:
            src += ' (%s)' % cls.__module__
    except Exception:
        pass
    return props, src


def run_probe(result_path):
    props, info = ensure_mmd_tools()
    ver = bpy.app.version_string
    ok = props is not None
    try:
        bpy.ops.export_scene.fbx.get_rna_type()
    except Exception:
        ok = False
        info = 'FBX 익스포터(io_scene_fbx)를 사용할 수 없음'
    line = '%s\t%s\t%s' % ('OK' if ok else 'FAIL', ver, info)
    write_text(result_path, line + '\n')
    log('probe: ' + line)
    return 0 if ok else 1


# ---------------------------------------------------------------- 유틸
def is_ascii(s):
    try:
        s.encode('ascii')
        return True
    except Exception:
        return False


def sanitize(s):
    s = re.sub(r'[^A-Za-z0-9_\-]+', '_', s or '')
    return s.strip('_')


class Namer(object):
    """원본 이름 -> 겹치지 않는 ASCII 이름"""

    def __init__(self):
        self.used = set()

    def make(self, orig, eng, prefix, idx, table=None):
        cand = ''
        if eng and is_ascii(eng):
            cand = sanitize(eng)
        if not cand and orig and is_ascii(orig):
            cand = sanitize(orig)
        if not cand and table and orig in table:
            cand = table[orig]
        if not cand:
            cand = '%s_%03d' % (prefix, idx)
        if cand[0].isdigit():
            cand = prefix + '_' + cand
        base = cand
        n = 2
        while cand.lower() in self.used:
            cand = '%s_%d' % (base, n)
            n += 1
        self.used.add(cand.lower())
        return cand


def set_active(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def image_alpha_info(img):
    """(알파 있음 여부, 반투명 픽셀 비율)"""
    try:
        if img.depth not in (32, 64, 128) or img.size[0] == 0:
            return False, 0.0
        import numpy as np
        n = img.size[0] * img.size[1] * 4
        arr = np.empty(n, dtype=np.float32)
        img.pixels.foreach_get(arr)
        a = arr[3::4]
        ratio = float((a < ALPHA_THRESHOLD).sum()) / float(len(a))
        return ratio >= ALPHA_MIN_RATIO, ratio
    except Exception as e:
        log('알파 검사 실패 %s: %r' % (img.name, e))
        return False, 0.0


def image_alpha_array(img, cache):
    """이미지의 알파 채널을 (높이, 너비) 배열로. 알파가 없으면 None."""
    key = img.name
    if key in cache:
        return cache[key]
    arr = None
    try:
        if img.depth in (32, 64, 128) and img.size[0] > 0 and img.size[1] > 0:
            import numpy as np
            w, h = img.size[0], img.size[1]
            buf = np.empty(w * h * 4, dtype=np.float32)
            img.pixels.foreach_get(buf)
            a = buf[3::4].reshape(h, w)
            if float(a.min()) < ALPHA_THRESHOLD:
                arr = a
    except Exception as e:
        log('알파 배열 읽기 실패 %s: %r' % (img.name, e))
    cache[key] = arr
    return arr


def material_alpha_ratios(obj):
    """재질마다, 그 재질의 면이 실제로 사용하는 UV 영역에서 반투명 픽셀이 차지하는 비율을 구한다.
    여러 재질이 텍스처 한 장을 나눠 쓰는 경우(예: Cloth2 / Cloth2Alpha) 불투명한 쪽까지
    투명 재질로 판정되는 것을 막기 위한 것이다. 반환: {재질 이름: 비율}"""
    import numpy as np
    res = {}
    me = obj.data
    if me.uv_layers.active is None or len(me.polygons) == 0:
        return res
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    if nt == 0:
        return res
    tl = np.empty(nt * 3, dtype=np.int32)
    me.loop_triangles.foreach_get('loops', tl)
    tm = np.empty(nt, dtype=np.int32)
    me.loop_triangles.foreach_get('material_index', tm)
    uv = np.empty(len(me.loops) * 2, dtype=np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    tri_uv = uv.reshape(-1, 2)[tl].reshape(nt, 3, 2)
    rng = np.random.RandomState(12345)
    cache = {}
    for mi, mat in enumerate(me.materials):
        if mat is None:
            continue
        img = find_base_image(mat)
        if img is None:
            continue
        a = image_alpha_array(img, cache)
        if a is None:
            res[mat.name] = 0.0
            continue
        sel = tri_uv[tm == mi]
        if len(sel) == 0:
            res[mat.name] = 0.0
            continue
        e1 = sel[:, 1] - sel[:, 0]
        e2 = sel[:, 2] - sel[:, 0]
        area = np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]) * 0.5
        total = float(area.sum())
        if total > 0:
            counts = np.clip(np.ceil(area / total * UV_ALPHA_SAMPLES), 4, 5000).astype(np.int64)
        else:
            counts = np.full(len(sel), 4, dtype=np.int64)
        idx = np.repeat(np.arange(len(sel)), counts)
        n = len(idx)
        r1 = np.sqrt(rng.random_sample(n))
        r2 = rng.random_sample(n)
        b0 = (1.0 - r1)[:, None]
        b1 = (r1 * (1.0 - r2))[:, None]
        b2 = (r1 * r2)[:, None]
        p = sel[idx, 0] * b0 + sel[idx, 1] * b1 + sel[idx, 2] * b2
        h, w = a.shape
        x = np.clip(np.floor((p[:, 0] % 1.0) * w).astype(np.int64), 0, w - 1)
        y = np.clip(np.floor((p[:, 1] % 1.0) * h).astype(np.int64), 0, h - 1)
        res[mat.name] = float((a[y, x] < ALPHA_THRESHOLD).mean())
    return res


def find_base_image(mat):
    if not mat.use_nodes or mat.node_tree is None:
        return None
    nodes = mat.node_tree.nodes
    node = nodes.get('mmd_base_tex')
    if node is not None and getattr(node, 'image', None) is not None:
        return node.image
    # 폴백: 셰이더에 색으로 연결된 첫 이미지 노드 (toon, sphere 는 제외)
    for n in nodes:
        if n.type == 'TEX_IMAGE' and n.image is not None and n.name not in ('mmd_toon_tex', 'mmd_sphere_tex'):
            return n.image
    return None


# ---------------------------------------------------------------- 변환 본체
def convert(args):
    pmx = os.path.abspath(args.input)
    out = os.path.abspath(args.output)
    out_dir = os.path.dirname(out)
    stem = os.path.splitext(os.path.basename(out))[0]
    keep_morphs = bool(int(args.morphs))
    if not os.path.isfile(pmx):
        raise RuntimeError('입력 파일이 없음: %s' % pmx)
    os.makedirs(out_dir, exist_ok=True)

    log('Blender %s' % bpy.app.version_string)
    log('입력: %s' % pmx)
    log('출력: %s' % out)
    log('옵션: morphs=%s split=%s scale=%s' % (keep_morphs, args.split, args.scale))

    # 빈 씬 (사용자 설정의 애드온은 유지)
    bpy.ops.wm.read_homefile(use_empty=True)
    props, info = ensure_mmd_tools()
    if props is None:
        raise RuntimeError(info)
    log('mmd_tools: %s' % info)

    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 0.01   # 1 Blender 단위 = 1cm

    # ---- PMX 임포트 (강체/조인트는 가져오지 않음)
    types = {'MESH', 'ARMATURE'}
    if keep_morphs:
        types.add('MORPHS')
    wanted = dict(
        filepath=pmx, types=types, scale=float(args.scale),
        clean_model=False, remove_doubles=False, fix_IK_links=False,
        apply_bone_fixed_axis=False, rename_bones=False, use_underscore=False,
        use_mipmap=False, log_level='ERROR', save_log=False,
    )
    kwargs = {k: v for k, v in wanted.items() if k in props}
    res = _IMPORT_OP[1](**kwargs)
    if 'FINISHED' not in res:
        raise RuntimeError('PMX 임포트 실패: %r' % (res,))

    objs = list(scene.objects)
    meshes = [o for o in objs if o.type == 'MESH' and getattr(o, 'mmd_type', 'NONE') == 'NONE']
    if not meshes:
        raise RuntimeError('임포트된 메시가 없음')

    # ---- 모델/모프 메타데이터 수집 (본을 지우기 전에)
    model_name = os.path.splitext(os.path.basename(pmx))[0]
    model_name_e = ''
    morph_eng = {}
    for o in objs:
        if getattr(o, 'mmd_type', '') == 'ROOT':
            root = o.mmd_root
            model_name_e = getattr(root, 'name_e', '') or ''
            for m in getattr(root, 'vertex_morphs', []):
                morph_eng[m.name] = getattr(m, 'name_e', '') or ''
            break

    # ---- 스킨/본 제거: 부모 해제, 모디파이어/버텍스 그룹 삭제, 트랜스폼 적용
    from mathutils import Matrix
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
        for m in list(o.modifiers):
            o.modifiers.remove(m)
        o.vertex_groups.clear()
    bpy.context.view_layer.update()
    for o in meshes:
        mw = o.matrix_world.copy()
        if mw != Matrix.Identity(4):
            o.data.transform(mw, shape_keys=True)
            o.matrix_world = Matrix.Identity(4)
    for o in objs:
        if o not in meshes:
            bpy.data.objects.remove(o, do_unlink=True)

    # ---- 셰이프 키 정리
    for o in meshes:
        keys = o.data.shape_keys
        if keys is None:
            continue
        for kb in keys.key_blocks:
            kb.value = 0.0
        o.active_shape_key_index = 0
        if not keep_morphs:
            o.shape_key_clear()

    # ---- 합치기 / 재질별 분리
    if len(meshes) > 1:
        set_active(meshes[0])
        for o in meshes:
            o.select_set(True)
        bpy.ops.object.join()
        meshes = [bpy.context.view_layer.objects.active]

    # ---- 재질별 알파 사용 여부 (분리하기 전, 재질을 다시 구성하기 전에 계산)
    uv_alpha = {}
    try:
        uv_alpha = material_alpha_ratios(meshes[0])
    except Exception as e:
        log('경고: 재질별 알파 판정 실패, 텍스처 단위 판정으로 대체: %r' % e)

    if args.split == 'material' and len(meshes[0].data.materials) > 1:
        set_active(meshes[0])
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.separate(type='MATERIAL')
        bpy.ops.object.mode_set(mode='OBJECT')
        meshes = [o for o in scene.objects if o.type == 'MESH']

    # ---- 변위가 없는 빈 셰이프 키 제거
    removed_empty = 0
    if keep_morphs:
        import numpy as np
        for o in meshes:
            keys = o.data.shape_keys
            if keys is None:
                continue
            nv = len(o.data.vertices)
            basis = np.empty(nv * 3, dtype=np.float32)
            keys.key_blocks[0].data.foreach_get('co', basis)
            for kb in list(keys.key_blocks)[1:]:
                co = np.empty(nv * 3, dtype=np.float32)
                kb.data.foreach_get('co', co)
                if nv == 0 or float(np.abs(co - basis).max()) < EMPTY_MORPH_EPSILON:
                    o.shape_key_remove(kb)
                    removed_empty += 1
            if o.data.shape_keys is not None and len(o.data.shape_keys.key_blocks) <= 1:
                o.shape_key_clear()

    # ---- 이름을 ASCII 로 변환
    # 모델 ID 는 출력 파일 이름을 쓴다 (PMX 의 영문 모델명은 'New_MMD_Model' 같은 기본값인 경우가 많다)
    model_id = sanitize(stem) or 'model'
    mapping = {'model': {'original': model_name, 'english': model_name_e, 'ascii': model_id},
               'objects': [], 'materials': [], 'morphs': []}

    # 재질
    mat_namer = Namer()
    tex_dir = os.path.join(out_dir, stem + '_tex')
    tex_copy = {}      # 원본 경로 -> ASCII 복사본 경로
    mats = []
    for o in meshes:
        for m in o.data.materials:
            if m is not None and m not in mats:
                mats.append(m)
    mat_rows = []
    for i, mat in enumerate(mats, 1):
        mm = getattr(mat, 'mmd_material', None)
        orig = (getattr(mm, 'name_j', '') or mat.name) if mm else mat.name
        eng = (getattr(mm, 'name_e', '') or '') if mm else ''
        diffuse = tuple(mm.diffuse_color) if mm else (0.8, 0.8, 0.8)
        opacity = float(mm.alpha) if mm else 1.0
        img = find_base_image(mat)
        tex_path = ''
        has_alpha = False
        alpha_ratio = 0.0
        tex_missing = False
        if img is not None:
            src = os.path.normpath(bpy.path.abspath(img.filepath))
            if os.path.isfile(src):
                if mat.name in uv_alpha:
                    alpha_ratio = uv_alpha[mat.name]
                    has_alpha = alpha_ratio >= ALPHA_MIN_RATIO
                else:
                    has_alpha, alpha_ratio = image_alpha_info(img)
                if not is_ascii(os.path.basename(src)):
                    if src not in tex_copy:
                        os.makedirs(tex_dir, exist_ok=True)
                        dst = os.path.join(tex_dir, 'tex_%03d%s' % (len(tex_copy) + 1, os.path.splitext(src)[1].lower()))
                        shutil.copy2(src, dst)
                        tex_copy[src] = dst
                    src = tex_copy[src]
                tex_path = src
            else:
                tex_missing = True
                tex_path = src
                log('경고: 텍스처 파일 없음: %s' % src)
        new_name = mat_namer.make(orig, eng, 'mat', i)

        # FBX 익스포터가 텍스처 경로를 기록하도록 Principled BSDF 로 다시 구성
        mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()
        out_node = nt.nodes.new('ShaderNodeOutputMaterial')
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        nt.links.new(bsdf.outputs['BSDF'], out_node.inputs['Surface'])
        bsdf.inputs['Base Color'].default_value = (diffuse[0], diffuse[1], diffuse[2], 1.0)
        if tex_path and not tex_missing:
            tex_node = nt.nodes.new('ShaderNodeTexImage')
            tex_node.image = bpy.data.images.load(tex_path, check_existing=True)
            nt.links.new(tex_node.outputs['Color'], bsdf.inputs['Base Color'])
            if has_alpha:
                nt.links.new(tex_node.outputs['Alpha'], bsdf.inputs['Alpha'])
        mat.name = new_name
        new_name = mat.name
        mapping['materials'].append({
            'original': orig, 'english': eng, 'ascii': new_name, 'texture': tex_path,
            'texture_missing': tex_missing, 'has_alpha': has_alpha,
            'alpha_ratio': round(alpha_ratio, 4), 'diffuse': [round(c, 4) for c in diffuse],
            'opacity': round(opacity, 4)})
        mat_rows.append('MAT\t%s\t%s\t%s\t%d\t%.4f %.4f %.4f\t%.4f' % (
            new_name, orig, '' if tex_missing else tex_path, 1 if has_alpha else 0,
            diffuse[0], diffuse[1], diffuse[2], opacity))

    # 모프 (셰이프 키)
    morph_namer = Namer()
    morph_map = {}
    morph_rows = []
    idx = 0
    for o in meshes:
        keys = o.data.shape_keys
        if keys is None:
            continue
        for kb in keys.key_blocks[1:]:
            orig = kb.name
            if orig not in morph_map:
                idx += 1
                morph_map[orig] = morph_namer.make(orig, morph_eng.get(orig, ''), 'morph', idx, MORPH_DICT)
                mapping['morphs'].append({'original': orig, 'english': morph_eng.get(orig, ''), 'ascii': morph_map[orig]})
                morph_rows.append('MORPH\t%s\t%s' % (morph_map[orig], orig))
    for o in meshes:
        keys = o.data.shape_keys
        if keys is None:
            continue
        keys.key_blocks[0].name = 'Basis'
        # 이름 충돌을 피하려고 임시 이름을 거친다
        blocks = list(keys.key_blocks[1:])
        origs = [kb.name for kb in blocks]
        for j, kb in enumerate(blocks):
            kb.name = '__tmp_%04d' % j
        for kb, orig in zip(blocks, origs):
            kb.name = morph_map[orig]

    # 오브젝트
    obj_namer = Namer()
    obj_rows = []
    for i, o in enumerate(meshes, 1):
        orig = o.name
        if args.split == 'material' and len(o.data.materials) >= 1 and o.data.materials[0] is not None:
            cand = '%s_%s' % (model_id, o.data.materials[0].name)
        else:
            cand = model_id if len(meshes) == 1 else '%s_%03d' % (model_id, i)
        new_name = obj_namer.make(cand, cand, 'mesh', i)
        o.name = new_name
        o.data.name = new_name
        # Max 에서 원본 이름을 복원할 때 쓸 표시 이름: 모델명 (+ 재질 원본 이름)
        display = model_name
        if len(meshes) > 1:
            mat0 = o.data.materials[0] if len(o.data.materials) else None
            mat_orig = next((m['original'] for m in mapping['materials']
                             if mat0 is not None and m['ascii'] == mat0.name), '')
            display = '%s_%s' % (model_name, mat_orig or ('%03d' % i))
        mapping['objects'].append({'original': orig, 'ascii': o.name, 'display': display})
        obj_rows.append('OBJ\t%s\t%s' % (o.name, display))

    # ---- FBX 익스포트
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    fbx_props = {p.identifier for p in bpy.ops.export_scene.fbx.get_rna_type().properties}
    fbx_wanted = dict(
        filepath=out, use_selection=True, object_types={'MESH'},
        use_mesh_modifiers=False, mesh_smooth_type=FBX_SMOOTH_TYPE,
        add_leaf_bones=False, bake_anim=False, use_custom_props=False,
        path_mode='ABSOLUTE', embed_textures=False,
        axis_forward='Y', axis_up='Z', bake_space_transform=False,
        global_scale=1.0, apply_unit_scale=True, apply_scale_options='FBX_SCALE_NONE',
    )
    res = bpy.ops.export_scene.fbx(**{k: v for k, v in fbx_wanted.items() if k in fbx_props})
    if 'FINISHED' not in res or not os.path.isfile(out):
        raise RuntimeError('FBX 익스포트 실패: %r' % (res,))

    # ---- 대응표 / 매니페스트 저장
    stats = {
        'blender': bpy.app.version_string, 'mmd_tools': info,
        'objects': len(meshes),
        'vertices': sum(len(o.data.vertices) for o in meshes),
        'faces': sum(len(o.data.polygons) for o in meshes),
        'materials': len(mats), 'morphs': len(morph_map),
        'removed_empty_morphs': removed_empty,
        'textures_copied_to_ascii': len(tex_copy),
        'textures_missing': sum(1 for m in mapping['materials'] if m['texture_missing']),
        'keep_morphs': keep_morphs, 'split': args.split, 'scale_cm': float(args.scale),
        'fbx_size': os.path.getsize(out),
    }
    mapping['stats'] = stats
    mapping['source'] = pmx
    write_text(os.path.join(out_dir, stem + '.json'), json.dumps(mapping, ensure_ascii=False, indent=2))
    rows = ['MODEL\t%s\t%s' % (model_id, model_name)] + obj_rows + mat_rows + morph_rows
    write_text(os.path.join(out_dir, stem + '.manifest.tsv'), '\n'.join(rows) + '\n')
    log('통계: ' + json.dumps(stats, ensure_ascii=False))
    log('PMX2FBX_OK')
    return 0


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser(prog='pmx_to_fbx.py')
    ap.add_argument('input', nargs='?')
    ap.add_argument('output', nargs='?')
    ap.add_argument('--probe', default='')
    ap.add_argument('--morphs', default='1', choices=['0', '1'])
    ap.add_argument('--split', default='merge', choices=['merge', 'material'])
    ap.add_argument('--scale', type=float, default=DEFAULT_SCALE_CM)
    ap.add_argument('--log', default='')
    args = ap.parse_args(argv)
    code = 1
    try:
        if args.probe:
            code = run_probe(args.probe)
        elif not args.input or not args.output:
            raise RuntimeError('입력 .pmx 와 출력 .fbx 경로가 필요함')
        else:
            code = convert(args)
    except SystemExit:
        raise
    except Exception as e:
        log('PMX2FBX_ERROR: %s' % e)
        log(traceback.format_exc())
        code = 1
    finally:
        if args.log:
            try:
                write_text(args.log, '\n'.join(_LOG) + '\n')
            except Exception:
                pass
    sys.stdout.flush()
    sys.exit(code)


main()
