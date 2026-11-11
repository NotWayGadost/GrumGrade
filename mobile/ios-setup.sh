#!/usr/bin/env bash
# Настройка iOS-проекта после `npx cap add ios` (запускается на macOS в GitHub Actions).
set -euo pipefail
cd "$(dirname "$0")"

APP=ios/App/App
PL="$APP/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "$1" "$PL"; }
setp() { pb "Set :$1 $3" 2>/dev/null || pb "Add :$1 $2 $3"; }

# Название под иконкой, светлый статус-бар на тёмном фоне, поворот экрана
setp CFBundleDisplayName string GRUMGrade
setp UIStatusBarStyle string UIStatusBarStyleLightContent
setp UIViewControllerBasedStatusBarAppearance bool false
setp UIRequiresFullScreen bool false
pb "Delete :UISupportedInterfaceOrientations" 2>/dev/null || true
pb "Add :UISupportedInterfaceOrientations array"
for o in UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight; do
  pb "Add :UISupportedInterfaceOrientations: string $o"
done

# Иконка приложения (один файл 1024×1024 — Xcode сам делает остальные размеры)
ICON="$APP/Assets.xcassets/AppIcon.appiconset"
rm -f "$ICON"/*.png
cp ../public/icons/icon-1024.png "$ICON/AppIcon-512@2x.png"
cat > "$ICON/Contents.json" <<'JSON'
{ "images": [ { "filename": "AppIcon-512@2x.png", "idiom": "universal", "platform": "ios", "size": "1024x1024" } ],
  "info": { "author": "xcode", "version": 1 } }
JSON

# Экран запуска: тёмный фон с логотипом G
SPLASH="$APP/Assets.xcassets/Splash.imageset"
if [ -d "$SPLASH" ]; then
  for f in "$SPLASH"/*.png; do cp ../public/icons/splash-2732.png "$f"; done
fi

echo "iOS-проект настроен: $(pb 'Print :CFBundleDisplayName')"
