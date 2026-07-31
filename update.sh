#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_DIR=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
TARGET=$(git -C "$SCRIPT_DIR" rev-parse --show-prefix)
TARGET=${TARGET%/}
REMOTE=${REMOTE:-origin}
BRANCH=${BRANCH:-master}

usage() {
  cat <<USAGE
用法: $0 <update|force|help>

命令:
  update  仅从远端更新仓库内的 $TARGET 目录，保留本地已跟踪改动
  force   强制覆盖 $TARGET 的本地改动，并删除该目录内未跟踪文件
  help    显示帮助

环境变量:
  REMOTE  Git 远端名，默认: origin
  BRANCH  Git 分支名，默认: master

说明:
  force 不会删除被 Git 忽略的运行时文件，例如 .local-workbench.log 和 .local-workbench.pid。
USAGE
}

fetch_remote() {
  if ! git -C "$REPO_DIR" remote get-url "$REMOTE" >/dev/null 2>&1; then
    echo "未找到 Git 远端: $REMOTE" >&2
    return 1
  fi

  echo "获取 $REMOTE/$BRANCH..."
  git -C "$REPO_DIR" fetch "$REMOTE" "$BRANCH"
}

update() {
  if ! git -C "$REPO_DIR" diff --quiet -- "$TARGET" ||
     ! git -C "$REPO_DIR" diff --cached --quiet -- "$TARGET"; then
    echo "$TARGET 存在未提交改动，已取消更新以避免覆盖本地修改。可使用: $0 force" >&2
    return 1
  fi

  fetch_remote
  echo "更新 $TARGET..."
  git -C "$REPO_DIR" restore --source="$REMOTE/$BRANCH" --staged --worktree -- "$TARGET"
  echo "$TARGET 更新完成。"
}

force_update() {
  fetch_remote
  echo "强制覆盖更新 $TARGET..."
  git -C "$REPO_DIR" clean -fd -- "$TARGET"
  git -C "$REPO_DIR" restore --source="$REMOTE/$BRANCH" --staged --worktree -- "$TARGET"
  echo "$TARGET 已强制更新完成。"
}

case "${1:-update}" in
  update)
    update
    ;;
  force)
    force_update
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "未知指令: $1" >&2
    usage >&2
    exit 1
    ;;
esac
