import { chromium } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

// Rasterize our source SVG for platform icon slots. No external image service.
const svg = await readFile("public/icon.svg", "utf8");
const browser = await chromium.launch(
  process.platform === "win32" ? { channel: "chrome" } : {},
);
try {
  const page = await browser.newPage();
  const targets = [
    ["public/icon-192.png", 192],
    ["public/icon-512.png", 512],
    ["public/apple-touch-icon.png", 180],
    ["ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", 1024],
  ];
  for (const [density, size] of [
    ["mdpi", 48],
    ["hdpi", 72],
    ["xhdpi", 96],
    ["xxhdpi", 144],
    ["xxxhdpi", 192],
  ]) {
    for (const name of ["ic_launcher", "ic_launcher_round"])
      targets.push([
        `android/app/src/main/res/mipmap-${density}/${name}.png`,
        size,
      ]);
    targets.push([
      `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`,
      size * 2.25,
    ]);
  }
  for (const [filename, size] of targets) {
    await mkdir(path.dirname(filename), { recursive: true });
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><style>html,body{margin:0;width:100%;height:100%;background:#0b1014}svg{width:100%;height:100%;display:block}</style>${svg}</html>`,
    );
    await page.screenshot({ path: filename });
  }
  console.log(`Generated ${targets.length} application icons.`);
} finally {
  await browser.close();
}
