#!/bin/sh
# Installs a pre-commit hook that runs gitleaks on the staged changes. Git does not commit hooks, so run this once per clone:
#   sh scripts/install-hooks.sh
# Needs gitleaks on the PATH (brew install gitleaks).
set -eu

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "install-hooks: gitleaks is not installed (brew install gitleaks); no hook written" >&2
  exit 1
fi

hook="$(git rev-parse --git-path hooks)/pre-commit"
mkdir -p "$(dirname "$hook")"
if [ -e "$hook" ] && ! grep -q "doorbell-gitleaks-hook" "$hook"; then
  echo "install-hooks: $hook already exists and was not written by this script; not overwriting it" >&2
  exit 1
fi

cat > "$hook" <<'HOOK'
#!/bin/sh
# doorbell-gitleaks-hook: refuse a commit whose staged changes hold a secret. (gitleaks protect --staged was replaced by git --pre-commit --staged.)
root="$(git rev-parse --show-toplevel)"
exec gitleaks git --pre-commit --staged --config "$root/.gitleaks.toml" --redact --no-banner --verbose "$root"
HOOK
chmod +x "$hook"
echo "install-hooks: pre-commit hook written to $hook"
