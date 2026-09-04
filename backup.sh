#!/bin/bash
# Backup script: git commit with optional tag
# Usage:
#   ./backup.sh [message]           # 普通备份
#   ./backup.sh [message] --tag     # 备份 + 打标签
#   ./backup.sh --list               # 查看历史
#   ./backup.sh --restore <hash>    # 回退到指定版本
#   ./backup.sh --tags               # 只查看标签

set -e

PROJ_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJ_DIR"

if [ ! -d ".git" ]; then
  echo "[ERROR] Not a git repo: $PROJ_DIR"
  exit 1
fi

# 彩色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

show_log() {
  echo -e "${BLUE}=== 备份历史 ===${NC}"
  git log --oneline --all -20
  echo ""
  echo -e "${BLUE}=== 标签 ===${NC}"
  git tag -n --sort=-creatordate
}

show_tags() {
  echo -e "${BLUE}=== 标签列表 ===${NC}"
  git tag -n --sort=-creatordate
}

restore() {
  local hash="$1"
  if [ -z "$hash" ]; then
    echo -e "${RED}[ERROR] 请指定版本hash${NC}"
    echo "用法: ./backup.sh --restore <hash>"
    echo ""
    show_log
    exit 1
  fi
  echo -e "${YELLOW}[WARNING] 将回退到版本: $hash${NC}"
  read -p "确认? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    git reset --hard "$hash"
    echo -e "${GREEN}[OK] 已回退到 $hash${NC}"
  else
    echo "[CANCELLED]"
  fi
}

# 解析参数
case "${1:-}" in
  --list)
    show_log
    exit 0
    ;;
  --tags)
    show_tags
    exit 0
    ;;
  --restore)
    restore "$2"
    exit 0
    ;;
  --help|-h)
    echo "用法:"
    echo "  ./backup.sh [message]           # 普通备份"
    echo "  ./backup.sh [message] --tag     # 备份 + 打标签"
    echo "  ./backup.sh --list              # 查看历史"
    echo "  ./backup.sh --restore <hash>   # 回退到指定版本"
    echo "  ./backup.sh --tags             # 查看标签"
    echo ""
    echo "示例:"
    echo "  ./backup.sh '修复移动端键盘问题'"
    echo "  ./backup.sh '新增备份功能' --tag"
    exit 0
    ;;
esac

MSG="${1:-$(date '+%Y-%m-%d %H:%M:%S')}"
ADD_TAG=false
if [ "$2" = "--tag" ]; then
  ADD_TAG=true
fi

git add -A
if git diff --cached --quiet; then
  echo -e "${YELLOW}[INFO] 没有变化需要提交${NC}"
  exit 0
fi

git commit -m "$MSG"
echo -e "${GREEN}[OK] 已提交: $MSG${NC}"

if $ADD_TAG; then
  TAG_NAME="v$(date '+%Y%m%d-%H%M%S')"
  git tag -a "$TAG_NAME" -m "$MSG"
  echo -e "${GREEN}[OK] 已打标签: $TAG_NAME${NC}"
fi

# Optional: push to remote
if git remote get-url origin &>/dev/null; then
  read -p "推送到远程? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    git push origin HEAD --tags
    echo -e "${GREEN}[OK] 已推送${NC}"
  fi
fi
