#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""hashscan - 文件 Hash 去重客户端：扫描本地文件、上传 hash，服务端返回重复的 hash。

功能说明：
  扫描一个目录，对每个文件算 hash，上传到服务端的指定项目；同一个项目里 hash
  已存在的文件就是重复文件。重复判断只看 hash，不看文件名。
  导入且取重：扫描上传的同时，把重复文件移到目标文件夹的子文件夹 duplicates。
  移动前先列出清单、让你输入 y 确认，确认后才移动。
  自体去重：同一批扫描里如果有内容相同的文件，也算重复，只保留第一个，
  其余的一起移到重复文件夹。

  重复文件夹默认是目标文件夹的子文件夹 duplicates（可用 --dup-dir 改）。

  只算文件头部 hash（加快速度）：
    默认只取每个文件开头 1MB 的内容算 SHA-256，小于 1MB 的文件取全部。
    速度快，但如果两个文件头部相同而后面不同，会被误判为重复——所以模式 2
    移动重复文件前，一定要先看清确认清单。头部大小可用 --head-size 改（单位 MB）。

用法：
  hashscan.py scan [目录] [--project <项目名>]
                   [--dup-dir <文件夹>] [--head-size <MB>]
  hashscan.py list
  hashscan.py stats <项目名>
  hashscan.py delete <项目名>
  hashscan.py --help

示例：
  python hashscan.py scan D:\照片 --project 照片库
  python hashscan.py scan D:\备份 --project 照片库 --dup-dir D:\重复文件
  python hashscan.py scan D:\视频 --project 视频库 --head-size 2
  python hashscan.py list
  python hashscan.py stats 照片库
  python hashscan.py delete 旧照片库

直接运行 hashscan.py（不带参数）就进扫描，一共两步，带步骤序号：
  步骤 1/2：输入一个要扫描的目录路径（输错了会让你重新输入，不会直接退出）。
  步骤 2/2：选项目（对照哪个库）——先列出已有项目，输入序号选用，
    上次用过的项目直接按 Enter 选用，也可以输入新项目名新建。
然后扫描上传，重复文件（和库重复 + 本批内重复）列出清单、输入 y 确认后
移到目标文件夹的子文件夹 duplicates。扫描时显示进度条（已扫多少/共多少、
百分比），不用装 tqdm。
头部大小等额外配置只在首次运行时问一次，存进配置文件 config.json，
以后直接用；不喜欢就删除配置文件，下次运行会重新问。
模式 2 的重复文件夹默认是目标文件夹的子文件夹 duplicates，不再追问，
可用 --dup-dir 改。命令行给了参数的直接用，不再追问。
鉴权：第一次运行时直接问你要 lightapi 的令牌，把浏览器里 lightapi 页面的
地址整个粘贴过来就行（带 ?token= 的那串），自动验证，通过后自动保存，
以后不用再输。也可以事先设环境变量 HASHSCAN_TOKEN。
直接双击运行：结束后停在完成提示、按 Enter 再退出，窗口不会一闪而过；
正常完成和出错都能在屏幕上看到，分得清。项目列表在后台预取，输入路径时不卡网络。
只用标准库，在哪台电脑上运行，就扫描哪台电脑上的文件。
本地缓存：扫描结果（路径、大小、修改时间、hash）存在配置文件同目录的
cache.json；下次扫描时文件没改动（大小 + 修改时间一致）就直接复用缓存的
hash，不重新读文件。上传失败也不丢扫描结果，下次重跑只扫新增/改动的文件。
不想要缓存就删除 cache.json。
"""
import hashlib
import json
import os
import shutil
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

BASE_URL = "https://app.shoc.zin7.de/web/lightapi/hashscan"
TOKEN_FILE = os.path.expanduser("~/.config/hashscan/token")
CHUNK = 1024 * 1024
DEFAULT_HEAD_MB = 1.0


def _extract_token(text):
    """从输入里取 token：可直接粘贴 lightapi 页面的地址（含 ?token=），也可只贴 token 本身。"""
    text = (text or "").strip()
    if not text:
        return ""
    if "token=" in text:
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(text).query)
        vals = qs.get("token") or []
        if vals:
            return vals[0].strip()
        # URL 里没解析到时，用 token= 后面到 & 或结尾的那段
        tail = text.split("token=", 1)[1]
        return tail.split("&")[0].strip()
    return text


def _validate_token(tok):
    """拿这个 token 实际请求一次 lightapi，拿到 JSON 数据（含 items）才算有效。
    只看 200 不行：无效 token 会被重定向到登录页（也是 200，但返回 HTML）。"""
    url = BASE_URL + "/records/hash_projects?perPage=1&token=" + urllib.parse.quote(tok)
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status != 200:
                return False
            data = json.loads(resp.read().decode("utf-8"))
            return isinstance(data, dict) and "items" in data
    except Exception:
        return False


def _save_token(tok):
    try:
        os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
        with open(TOKEN_FILE, "w", encoding="utf-8") as f:
            f.write(tok)
        return True
    except OSError as e:
        print("保存令牌失败（%s），本次只用这一次，下次还要再输。" % e)
        return False


CONFIG_FILE = os.path.join(os.path.dirname(TOKEN_FILE), "config.json")


def _load_config():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
            return cfg if isinstance(cfg, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_config(cfg):
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        return True
    except OSError:
        return False


# 本地扫描缓存：存 path -> {hash, size, mtime, head_mb}，避免一次上传失败后
# 下次重跑又要把全部文件重新读一遍算 hash。命中条件是 size + mtime + head_mb
# 都一致（文件没动过），只读文件头算 hash 本来就快，但 2763 个文件重读一遍
# 仍要不少时间；缓存命中后只做 stat，不读文件内容。缓存与 token 同目录。
CACHE_FILE = os.path.join(os.path.dirname(TOKEN_FILE), "cache.json")


def _load_cache():
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            c = json.load(f)
            return c if isinstance(c, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_cache(cache):
    try:
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
        return True
    except OSError:
        return False


def _ensure_head_mb(cfg):
    """头部大小只在首次运行时问一次，存进配置文件；以后直接用。
    不喜欢就删除配置文件，下次运行会重新问。"""
    v = cfg.get("head_mb")
    try:
        v = float(v)
        if v > 0:
            return v
    except (TypeError, ValueError):
        pass
    print("第一次使用，先设置一次配置（以后不再问；不喜欢就删除配置文件重新设置）。")
    print("配置文件：%s" % CONFIG_FILE)
    s = _ask("头部取多少 MB（默认 1，小于 1MB 的文件取全部）[1]：", "1")
    if s is None:
        return None
    try:
        v = float(s)
        if v <= 0:
            raise ValueError
    except (TypeError, ValueError):
        print("头部大小无效，用默认 1 MB。")
        v = DEFAULT_HEAD_MB
    cfg["head_mb"] = v
    _save_config(cfg)
    return v


def _show_progress(done, total):
    """内置进度条（不用装 tqdm）：扫描中： 1234/5678 [##########----------] 21%"""
    if total <= 0:
        return
    pct = done * 100 // total
    bar_len = 30
    filled = pct * bar_len // 100
    bar = "#" * filled + "-" * (bar_len - filled)
    print("\r扫描中：%d/%d [%s] %d%%" % (done, total, bar, pct), end="", flush=True)


def _collect_files(root, dup_abs):
    """先走一遍目录，收集要扫描的文件清单（跳过重复文件夹和符号链接），供进度条算总数。"""
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        adir = os.path.abspath(dirpath)
        if dup_abs and (adir == dup_abs or adir.startswith(dup_abs + os.sep)):
            dirnames[:] = []
            continue
        if dup_abs:
            for d in list(dirnames):
                if os.path.abspath(os.path.join(dirpath, d)) == dup_abs:
                    dirnames.remove(d)
        dirnames.sort()
        for fn in sorted(filenames):
            fpath = os.path.join(dirpath, fn)
            if os.path.islink(fpath):
                continue
            files.append(fpath)
    return files


def _token():
    tok = os.environ.get("HASHSCAN_TOKEN", "").strip()
    if tok:
        return tok
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            tok = f.read().strip()
            if tok:
                return tok
    except OSError:
        pass
    # 没找到令牌：直接问用户要，粘贴地址或 token 都行，验证通过才保存使用
    print("第一次使用需要 lightapi 的令牌。")
    print("获取方法：浏览器登录面板后打开 https://app.shoc.zin7.de/web/lightapi/ ，")
    print("把地址栏的地址整个粘贴过来就行（带 ?token= 的那串），也可以只贴 token 本身。")
    while True:
        raw = _ask("请输入 lightapi 地址或令牌：")
        if raw is None or not raw.strip():
            print("未输入令牌，已取消。")
            return ""
        tok = _extract_token(raw)
        if not tok:
            print("没取到令牌，请重新输入。")
            continue
        print("正在验证令牌…")
        if _validate_token(tok):
            print("令牌有效，已保存，以后不用再输。")
            _save_token(tok)
            return tok
        print("令牌无效（请求失败或已过期），请重新获取后粘贴。")


def _need_token():
    # _token() 里已经把原因说清楚了，这里只返回失败码，不重复打印。
    return 1


def _api(method, path, params=None, body=None, tok=None, quiet=False):
    """tok 已给就直接用（后台线程传进来，避免子线程里弹输入提示）；
    quiet=True 时不打印请求失败（后台预取失败不打扰正在输入的用户）。"""
    if tok is None:
        tok = _token()
    if not tok:
        return None, _need_token()
    qs = dict(params or {})
    qs["token"] = tok
    url = BASE_URL + path
    if qs:
        url += "?" + urllib.parse.urlencode(qs)
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8")), 0
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore")[:300]
        if not quiet:
            print("请求失败：HTTP %s %s" % (e.code, detail))
        return None, 1
    except Exception as e:
        if not quiet:
            print("请求失败：%s" % e)
        return None, 1


def _esc_filter_value(v):
    return v.replace("\\", "\\\\").replace('"', '\\"')


def _get_project(name):
    data, rc = _api("GET", "/records/hash_projects",
                    {"filter": 'name="%s"' % _esc_filter_value(name), "perPage": 1})
    if data is None:
        return None, rc
    items = data.get("items") or []
    return (items[0] if items else None), 0


def _fetch_projects_bg(tok, holder):
    """后台预取项目列表：只在子线程里跑网络请求，失败也不打印（不打扰主线程正在输入的用户）。"""
    try:
        data, rc = _api("GET", "/records/hash_projects",
                        {"perPage": 200, "sort": "name",
                         "fields": "id,name,file_count,total_size,updated_at"},
                        tok=tok, quiet=True)
    except Exception:
        data, rc = None, 1
    holder["data"] = data
    holder["rc"] = rc
    holder["done"].set()


def _pick_project(cfg, prefetch=None):
    """列出已有项目，按序号选用，或输入新项目名。上次用过的项目直接按 Enter 选用。返回项目名，取消返回 None。
    prefetch 是后台预取的结果（步骤 1/2 输路径时就开始取了），到了这一步一般已经取好，不用再等网络。"""
    if prefetch is not None:
        if not prefetch["done"].is_set():
            print("正在加载项目列表…")
        # 等待有界：网络慢时不无限期卡住输入阶段，超时就走手动输入
        prefetch["done"].wait(timeout=20)
        if not prefetch["done"].is_set():
            print("项目列表加载超时（网络慢），可直接输入项目名继续。")
            data, rc = None, 1
        else:
            data, rc = prefetch["data"], prefetch["rc"]
            if data is None:
                # 后台没取到，主线程再试一次（这次带提示）
                data, rc = _api("GET", "/records/hash_projects",
                                {"perPage": 200, "sort": "name",
                                 "fields": "id,name,file_count,total_size,updated_at"})
    else:
        data, rc = _api("GET", "/records/hash_projects",
                        {"perPage": 200, "sort": "name",
                         "fields": "id,name,file_count,total_size,updated_at"})
    if data is None:
        # 列表取不到不等于不能继续：手动输入项目名（已有项目同名即对照该库）
        name = _ask("输入项目名（已有项目同名即对照该库，直接回车取消）：")
        return name or None
    items = data.get("items") or []
    last = (cfg or {}).get("last_project") or ""
    if items:
        print("已有项目：")
        for i, it in enumerate(items, 1):
            mark = "（上次用的）" if last and it.get("name") == last else ""
            print("  %d. %s（%s 个文件）%s" % (i, it.get("name", ""), it.get("file_count", 0), mark))
    else:
        print("还没有项目，输入项目名新建。")
    hint = (" [直接按 Enter 用“%s”]" % last) if last else ""
    s = _ask("输入序号选用，或直接输入项目名（不存在则新建）%s：" % hint, last if last else None)
    if s is None or not s:
        return None
    if s.isdigit():
        idx = int(s)
        if 1 <= idx <= len(items):
            return items[idx - 1].get("name")
        print("序号超出范围。")
        return None
    return s


def _create_project(name):
    data, rc = _api("POST", "/records/hash_projects",
                    body={"name": name, "hashes": "[]", "file_count": 0,
                          "total_size": 0, "updated_at": ""})
    if data is None:
        return None, rc
    return data, 0


def _parse_hashes(record):
    raw = record.get("hashes") or "[]"
    try:
        items = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    out = {}
    if isinstance(items, list):
        for it in items:
            if isinstance(it, dict) and it.get("hash"):
                out[it["hash"]] = it
    return out


def _fmt_size(n):
    n = int(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return "%d %s" % (n, unit) if unit == "B" else "%.1f %s" % (n, unit)
        n /= 1024.0
    return "%d B" % n


def _sha256_head(path, head_bytes):
    """只读文件开头 head_bytes 字节算 SHA-256（小于该大小的文件取全部）。"""
    h = hashlib.sha256()
    remaining = head_bytes
    with open(path, "rb") as f:
        while remaining > 0:
            chunk = f.read(min(CHUNK, remaining))
            if not chunk:
                break
            h.update(chunk)
            remaining -= len(chunk)
    return h.hexdigest()


def _ask(prompt, default=None):
    """input() 问一句；空输入用 default；EOF/Ctrl-C 返回 None（表示取消）。"""
    try:
        s = input(prompt).strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return None
    if not s:
        return default
    return s




def _move_unique(src, dest_dir):
    """把 src 移进 dest_dir；同名文件加 (1)(2)... 后缀，绝不覆盖。返回目标路径。"""
    os.makedirs(dest_dir, exist_ok=True)
    base = os.path.basename(src)
    dest = os.path.join(dest_dir, base)
    if not os.path.exists(dest):
        shutil.move(src, dest)
        return dest
    stem, ext = os.path.splitext(base)
    n = 1
    while True:
        cand = os.path.join(dest_dir, "%s (%d)%s" % (stem, n, ext))
        if not os.path.exists(cand):
            shutil.move(src, cand)
            return cand
        n += 1


def _cmd_scan(args):
    cfg = _load_config()
    # --- 解析命令行参数（给了就直接用）---
    root = None
    project = None
    dup_dir = None
    head_mb = None
    positional = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--project" and i + 1 < len(args):
            project = args[i + 1]; i += 2
        elif a == "--dup-dir" and i + 1 < len(args):
            dup_dir = args[i + 1]; i += 2
        elif a == "--head-size" and i + 1 < len(args):
            head_mb = args[i + 1]; i += 2
        elif a.startswith("--"):
            print("未知参数：%s" % a)
            return 1
        else:
            positional.append(a); i += 1
    if positional:
        root = positional[0]

    # --- 项目列表后台预取：令牌先在主线程解析好（首次运行会问一次），
    # 再起子线程取项目列表；用户输路径、答配置问题的时间里，列表已经在后台取，
    # 到步骤 2/2 一般直接就能选，不用在输入完路径后干等网络。命令行已给 --project 的不用预取。---
    prefetch = None
    if not project:
        tok = _token()
        if not tok:
            return _need_token()
        prefetch = {"done": threading.Event(), "data": None, "rc": 1}
        threading.Thread(target=_fetch_projects_bg, args=(tok, prefetch), daemon=True).start()

    # --- 头部大小：只在首次运行时问一次，存进配置文件；以后直接用 ---
    if head_mb is None:
        head_mb = _ensure_head_mb(cfg)
        if head_mb is None:
            return 1
    else:
        try:
            head_mb = float(head_mb)
            if head_mb <= 0:
                raise ValueError
        except (ValueError, TypeError):
            print("头部大小无效，用默认 1 MB。")
            head_mb = DEFAULT_HEAD_MB

    # --- 步骤 1/2：输入一个路径 ---
    if not root:
        while True:
            root = _ask("步骤 1/2：扫描哪个目录（例如 D:\\照片）：")
            if root is None:
                print("已取消。")
                return 1
            if not root:
                print("未输入目录，已取消。")
                return 1
            if os.path.isdir(root):
                break
            print("目录不存在：%s，请重新输入。" % root)
            root = None
    elif not os.path.isdir(root):
        print("目录不存在：%s" % root)
        return 1
    root = os.path.abspath(root)

    # --- 步骤 2/2：选项目 ---
    if not project:
        print("步骤 2/2：选项目（对照哪个库）")
        project = _pick_project(cfg, prefetch=prefetch)
        if not project:
            print("未选择项目，已取消。")
            return 1

    if not dup_dir:
        # 默认：重复文件放目标文件夹的子文件夹，不再追问（可用 --dup-dir 改）
        dup_dir = os.path.join(root, "duplicates")
        print("重复文件默认移到目标文件夹的子文件夹：%s" % dup_dir)
    head_bytes = int(head_mb * 1024 * 1024)
    if head_bytes < 1024:
        head_bytes = 1024
    dup_abs = os.path.abspath(dup_dir) if dup_dir else None

    proj, rc = _get_project(project)
    if proj is None and rc != 0:
        return rc
    if proj is None:
        print("项目 %s 不存在，新建空项目。" % project)
        proj, rc = _create_project(project)
        if proj is None:
            return rc
    stored = _parse_hashes(proj)

    # 头部大小一致性提醒：不同头部大小算出的 hash 不可比
    stored_heads = set()
    no_head = 0
    for e in stored.values():
        if e.get("head_mb") is None:
            no_head += 1
        else:
            stored_heads.add(e.get("head_mb"))
    if no_head:
        print("注意：项目里有 %d 条未记录头部大小的旧记录，无法确认是否可比。" % no_head)
    if stored_heads and head_mb not in stored_heads:
        print("注意：项目里已有用 %s MB 头部扫描的记录，本次用 %s MB，两者 hash 不可比，"
              "同一文件可能被当成两个。建议以后固定用一个头部大小。" % (
                  sorted(stored_heads), head_mb))

    files = _collect_files(root, dup_abs)
    total = len(files)
    print("共 %d 个文件，开始扫描…" % total)
    cache = _load_cache()
    cache_hits = 0
    cache_dirty = False
    scanned = 0
    dups_lib = []   # 与库重复：(hash, local_path, stored_path)
    dups_self = []  # 本批内重复：(hash, local_path, first_local_path)
    added = 0
    skipped = 0
    merged = dict(stored)
    last_pct = -1
    for fpath in files:
        try:
            st = os.stat(fpath)
        except OSError as e:
            print("跳过（读不到）：%s (%s)" % (fpath, e))
            skipped += 1
            scanned += 1
            continue
        # 本地缓存命中（大小 + 修改时间 + 头部大小都一致）就直接用上次的 hash，
        # 不读文件；否则重新算 hash 并更新缓存。
        cent = cache.get(fpath)
        if (isinstance(cent, dict) and cent.get("hash")
                and int(cent.get("size") or -1) == st.st_size
                and int(cent.get("mtime") or -1) == int(st.st_mtime)
                and float(cent.get("head_mb") or -1) == head_mb):
            digest = cent["hash"]
            cache_hits += 1
        else:
            try:
                digest = _sha256_head(fpath, head_bytes)
            except OSError as e:
                print("跳过（读不到）：%s (%s)" % (fpath, e))
                skipped += 1
                scanned += 1
                continue
            cache[fpath] = {"hash": digest, "size": st.st_size,
                            "mtime": int(st.st_mtime), "head_mb": head_mb}
            cache_dirty = True
        scanned += 1
        if digest in merged:
            if digest in stored:
                dups_lib.append((digest, fpath, merged[digest].get("path", "")))
            else:
                dups_self.append((digest, fpath, merged[digest].get("path", "")))
        else:
            merged[digest] = {
                "hash": digest,
                "path": fpath,
                "size": st.st_size,
                "mtime": int(st.st_mtime),
                "head_mb": head_mb,
            }
            added += 1
        if total:
            pct = scanned * 100 // total
            if pct != last_pct:
                _show_progress(scanned, total)
                last_pct = pct
    print()

    # 扫描结果先落本地缓存再上传：上传失败（413/502）时，下次重跑直接复用缓存，
    # 不用把 2763 个文件重新读一遍算 hash。
    if cache_dirty:
        _save_cache(cache)
    if cache_hits:
        print("本地缓存命中 %d 个文件（未改动，直接复用上次的 hash，未重新读文件）。" % cache_hits)

    # 增量上传：只发本次新增的条目（add_hashes），服务端合并进库。
    # 以前是全量清单 PATCH，清单随库变大，迟早超服务端上限（2MB 时 413/502）。
    # 现在单次上传只有新增的几条，库多大都不怕；服务端返回更新后的总数。
    new_entries = [v for k, v in merged.items() if k not in stored]
    merged_count = len(merged)
    merged_total = sum(int(v.get("size") or 0) for v in merged.values())
    if new_entries:
        resp, rc = _api("PATCH", "/records/hash_projects/" + proj["id"],
                        body={"add_hashes": new_entries,
                              "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")})
        if rc != 0:
            return rc
        if isinstance(resp, dict):
            if resp.get("file_count") is not None:
                merged_count = int(resp["file_count"])
            if resp.get("total_size") is not None:
                merged_total = int(resp["total_size"])

    dups = dups_lib + dups_self
    print("扫描完成：%s（头部 %s MB）" % (root, head_mb))
    print("  本次扫描：%d 个文件，新增 %d 个，与库重复 %d 个，本批内重复 %d 个%s" % (
        scanned, added, len(dups_lib), len(dups_self),
        ("，跳过 %d 个" % skipped) if skipped else ""))
    print("  项目 %s 现有：%d 个文件，共 %s" % (
        project, merged_count, _fmt_size(merged_total)))
    if dups_lib:
        print("与库重复的文件：")
        for digest, local, stored_path in dups_lib:
            print("  %s" % digest)
            print("    本地：%s" % local)
            print("    库里已有：%s" % stored_path)
    if dups_self:
        print("本批内重复的文件（只保留第一个，其余的视为重复）：")
        for digest, local, first_path in dups_self:
            print("  %s" % digest)
            print("    本地：%s" % local)
            print("    本批首次出现：%s" % first_path)

    if dups:
        print()
        confirm = _ask("确认移动以上 %d 个重复文件到 %s 吗？输入 y 确认，其他任意键取消：" % (
            len(dups), dup_abs))
        if not confirm or confirm.lower() != "y":
            print("已取消移动（hash 已上传，文件没动）。")
            return 0
        moved = 0
        failed = 0
        for digest, local, stored_path in dups:
            if not os.path.exists(local):
                print("跳过（已不在）：%s" % local)
                continue
            try:
                dest = _move_unique(local, dup_abs)
                print("已移动：%s -> %s" % (local, dest))
                moved += 1
            except OSError as e:
                print("移动失败：%s (%s)" % (local, e))
                failed += 1
        print("移动完成：%d 个已移入 %s，失败 %d 个。" % (moved, dup_abs, failed))
    cfg["last_project"] = project
    _save_config(cfg)
    return 0


def _cmd_delete(args):
    name = args[0] if args else None
    if not name:
        name = _pick_project(_load_config())
        if not name:
            print("未选择项目，已取消。")
            return 1
    proj, rc = _get_project(name)
    if proj is None and rc != 0:
        return rc
    if proj is None:
        print("没有这个项目：%s" % name)
        return 1
    n = proj.get("file_count", 0)
    print("删除项目 %s 会删掉该项目下全部 %s 条 hash 记录，此操作不可恢复。" % (name, n))
    confirm = _ask("输入项目名确认删除（输入其他内容取消）：")
    if confirm != name:
        print("已取消删除。")
        return 0
    _, rc = _api("DELETE", "/records/hash_projects/" + proj["id"])
    if rc != 0:
        return rc
    print("已删除项目 %s。" % name)
    return 0


def _cmd_list():
    data, rc = _api("GET", "/records/hash_projects",
                    {"perPage": 200, "sort": "name",
                     "fields": "id,name,file_count,total_size,updated_at"})
    if data is None:
        return rc
    items = data.get("items") or []
    if not items:
        print("还没有项目。用 hashscan.py scan <目录> --project <项目名> 创建一个。")
        return 0
    print("%-20s %-10s %-12s %s" % ("项目名", "文件数", "总大小", "更新时间"))
    for it in items:
        print("%-20s %-10s %-12s %s" % (
            it.get("name", ""), it.get("file_count", 0),
            _fmt_size(it.get("total_size", 0)), it.get("updated_at") or "-"))
    return 0


def _cmd_stats(args):
    name = args[0] if args else None
    if not name:
        name = _pick_project(_load_config())
        if not name:
            print("未选择项目，已取消。")
            return 1
    proj, rc = _get_project(name)
    if proj is None and rc != 0:
        return rc
    if proj is None:
        print("没有这个项目：%s" % name)
        return 1
    stored = _parse_hashes(proj)
    total = sum(int(v.get("size") or 0) for v in stored.values())
    heads = sorted(set(v.get("head_mb") for v in stored.values() if v.get("head_mb") is not None))
    print("项目：%s" % name)
    print("  文件数：%d" % len(stored))
    print("  总大小：%s" % _fmt_size(total))
    print("  头部大小：%s MB" % (", ".join(str(h) for h in heads) if heads else "未知"))
    print("  更新：%s" % (proj.get("updated_at") or "-"))
    return 0




def main(argv):
    args = argv[1:]
    if not args:
        return _cmd_scan([])
    if args[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return 0
    cmd = args[0]
    if cmd == "scan":
        return _cmd_scan(args[1:])
    if cmd == "list":
        return _cmd_list()
    if cmd == "stats":
        return _cmd_stats(args[1:])
    if cmd == "delete":
        return _cmd_delete(args[1:])
    print("未知命令：%s（用 hashscan.py --help 看用法）" % cmd)
    return 1


def _pause_before_exit(rc):
    """双击运行时控制台不会一闪而过：结束时停住，等用户按 Enter 再退出。
    正常完成和出错都停住，这样一眼就能分清是正常结束还是闪退。"""
    try:
        if rc == 0:
            input("\n已完成，按 Enter 退出…")
        else:
            input("\n已结束（未完成，原因见上方），按 Enter 退出…")
    except (EOFError, KeyboardInterrupt):
        print()


if __name__ == "__main__":
    _rc = 0
    # 不带参数就是交互式（双击运行也是这种）：结束时停住等用户按 Enter，
    # 否则控制台直接关闭，分不清是正常结束还是出错闪退。带参数的命令行用法不暂停。
    _interactive = len(sys.argv) <= 1
    try:
        _rc = main(sys.argv)
    except KeyboardInterrupt:
        print("\n已取消。")
        _rc = 1
    except Exception:
        import traceback
        traceback.print_exc()
        _rc = 1
    if _interactive:
        _pause_before_exit(_rc)
    sys.exit(_rc)
