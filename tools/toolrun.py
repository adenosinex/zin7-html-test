#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""toolrun - 统一本地脚本执行客户端：按简称拉取工具并执行。

用法：
  toolrun list                        列出注册表里所有工具
  toolrun <简称> [参数...]             拉取并执行工具（参数原样传给工具）
  toolrun <简称> --update [参数...]    强制重新拉取再执行

示例：
  toolrun ft flatten D:\下载
  toolrun ft D:\下载
  toolrun ft group D:\下载 --yes

鉴权：从 %USERPROFILE%\.config\toolrun\token 或环境变量 TOOLRUN_TOKEN 读 lightapi 的
URL token，拼成 ?token= 随请求发给面板。获取方法：浏览器登录面板后打开
https://app.shoc.zin7.de/web/lightapi/ ，地址栏 ?token= 后面的值就是令牌，
把它保存到 %USERPROFILE%\.config\toolrun\token（不要把令牌发给任何人）。
工具缓存在 %USERPROFILE%\.local\share\toolrun\<简称>\main.py，按 version 判断是否更新。
只用标准库。
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://app.shoc.zin7.de/web/lightapi/tools"
CACHE_DIR = os.path.expanduser("~/.local/share/toolrun")
TOKEN_FILE = os.path.expanduser("~/.config/toolrun/token")


def _token():
    tok = os.environ.get("TOOLRUN_TOKEN", "").strip()
    if tok:
        return tok
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _api(path, params=None):
    tok = _token()
    if not tok:
        print("未找到令牌。请把 lightapi 的 URL token 保存到 %USERPROFILE%\\.config\\toolrun\\token，")
        print("或设置环境变量 TOOLRUN_TOKEN。")
        print("获取方法：浏览器登录面板后打开 https://app.shoc.zin7.de/web/lightapi/ ，")
        print("地址栏 ?token= 后面的值就是令牌。")
        return None
    qs = dict(params or {})
    qs["token"] = tok
    url = BASE_URL + path + "?" + urllib.parse.urlencode(qs)
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")[:200]
        print("拉取失败：HTTP %s %s" % (e.code, body))
        return None
    except Exception as e:
        print("拉取失败：%s" % e)
        return None


def _get_tool(short):
    data = _api("/records/tools", {"filter": 'short="%s"' % short, "perPage": 1})
    if not data:
        return None
    items = data.get("items") or []
    if not items:
        print("注册表里没有简称 %s 的工具。试试 toolrun list。" % short)
        return None
    return items[0]


def _list_tools():
    data = _api("/records/tools", {"perPage": 200, "sort": "short"})
    if not data:
        return 1
    items = data.get("items") or []
    if not items:
        print("注册表是空的。")
        return 0
    print("%-10s %-8s %s" % ("简称", "版本", "名称 / 描述"))
    for it in items:
        desc = it.get("desc") or ""
        print("%-10s %-8s %s%s" % (
            it.get("short", ""), it.get("version", ""),
            it.get("name", ""), (" - " + desc) if desc else ""))
    return 0


def _ensure_local(tool, force=False):
    short = tool["short"]
    version = tool.get("version") or 0
    entry = tool.get("entry") or "main.py"
    d = os.path.join(CACHE_DIR, short)
    os.makedirs(d, exist_ok=True)
    target = os.path.join(d, entry)
    meta_path = os.path.join(d, ".meta.json")
    cur_ver = None
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                cur_ver = json.load(f).get("version")
        except Exception:
            cur_ver = None
    if not force and os.path.exists(target) and cur_ver == version:
        return target
    code = tool.get("code") or ""
    with open(target, "w", encoding="utf-8") as f:
        f.write(code)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump({"version": version, "short": short}, f)
    print("已拉取 %s v%s 到 %s" % (short, version, target))
    return target


def _install_deps(tool):
    deps = (tool.get("deps") or "").strip()
    if not deps:
        return True
    pkgs = [ln.strip() for ln in deps.splitlines()
            if ln.strip() and not ln.strip().startswith("#")]
    if not pkgs:
        return True
    print("安装依赖：%s" % " ".join(pkgs))
    r = subprocess.call([sys.executable, "-m", "pip", "install", "--user"] + pkgs)
    if r != 0:
        print("依赖安装失败，已停止，不会执行旧代码。")
        return False
    return True


def main(argv):
    args = argv[1:]
    if not args or args[0] in ("-h", "--help", "help"):
        print("用法：")
        print("  toolrun list                     列出所有工具")
        print("  toolrun <简称> [参数...]          拉取并执行工具")
        print("  toolrun <简称> --update [参数...] 强制重新拉取再执行")
        print("示例：")
        print("  toolrun ft flatten D:\\下载")
        print("  toolrun ft D:\\下载")
        return 0
    if args[0] == "list":
        return _list_tools()
    short = args[0]
    rest = args[1:]
    force = False
    if "--update" in rest:
        force = True
        rest = [a for a in rest if a != "--update"]
    tool = _get_tool(short)
    if not tool:
        return 1
    target = _ensure_local(tool, force=force)
    if not _install_deps(tool):
        return 1
    # 把 short 之后的所有参数原样传给工具，stdin/stdout/stderr 直接接管
    return subprocess.call([sys.executable, target] + rest)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
