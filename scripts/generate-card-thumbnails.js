"use strict";
// =============================
// v0.9.4 卡牌/Token 缩略图生成脚本
// 用法: node scripts/generate-card-thumbnails.js
// 依赖: sharp (devDependency)
//
// 输入:
//   assets/cards/*.png   (90 张卡牌原图，平均 705KB/张)
//   assets/tokens/*.png  (6 个 token 图标，512x512 ~200KB/张)
//
// 输出:
//   assets/cards/thumbs/*.webp  (宽度 280px，保持比例，quality 80)
//   assets/tokens/thumbs/*.webp (宽度 64px，保持比例，quality 80)
//
// 不覆盖原 PNG。不修改 cards.json。
// =============================
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");
const CARDS_DIR = path.join(ROOT, "assets", "cards");
const CARDS_THUMBS_DIR = path.join(CARDS_DIR, "thumbs");
const TOKENS_DIR = path.join(ROOT, "assets", "tokens");
const TOKENS_THUMBS_DIR = path.join(TOKENS_DIR, "thumbs");

const CARD_WIDTH = 280;
const CARD_QUALITY = 80;
const TOKEN_WIDTH = 64;
const TOKEN_QUALITY = 80;

async function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[创建目录] ${dir}`);
  }
}

async function generateThumbs(srcDir, outDir, width, quality, label) {
  await ensureDir(outDir);
  const files = fs.readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith(".png"));
  let totalOriginal = 0;
  let totalThumb = 0;
  let count = 0;

  for (const file of files) {
    const srcPath = path.join(srcDir, file);
    const baseName = path.basename(file, ".png");
    const outPath = path.join(outDir, baseName + ".webp");

    try {
      const srcStat = fs.statSync(srcPath);
      totalOriginal += srcStat.size;

      await sharp(srcPath)
        .resize({ width: width, withoutEnlargement: true })
        .webp({ quality: quality })
        .toFile(outPath);

      const outStat = fs.statSync(outPath);
      totalThumb += outStat.size;
      count++;
    } catch (e) {
      console.error(`[失败] ${file}: ${e.message}`);
    }
  }

  const origKB = (totalOriginal / 1024).toFixed(1);
  const thumbKB = (totalThumb / 1024).toFixed(1);
  const ratio = totalOriginal > 0 ? ((1 - totalThumb / totalOriginal) * 100).toFixed(1) : 0;
  console.log(`[${label}] 生成 ${count} 张缩略图`);
  console.log(`  原图总大小: ${origKB} KB`);
  console.log(`  缩略图总大小: ${thumbKB} KB`);
  console.log(`  压缩比例: ${ratio}% (越小越好)`);

  return { count, totalOriginal, totalThumb };
}

(async () => {
  console.log("=========================================");
  console.log("v0.9.4 缩略图生成");
  console.log("=========================================");
  console.log(`项目根目录: ${ROOT}`);
  console.log("");

  if (!fs.existsSync(CARDS_DIR)) {
    console.error(`错误: 卡牌目录不存在 ${CARDS_DIR}`);
    process.exit(1);
  }

  const cardResult = await generateThumbs(CARDS_DIR, CARDS_THUMBS_DIR, CARD_WIDTH, CARD_QUALITY, "卡牌");
  console.log("");
  const tokenResult = await generateThumbs(TOKENS_DIR, TOKENS_THUMBS_DIR, TOKEN_WIDTH, TOKEN_QUALITY, "Token");
  console.log("");
  console.log("=========================================");
  console.log("汇总:");
  console.log(`  卡牌: ${cardResult.count} 张, ${(cardResult.totalOriginal/1024/1024).toFixed(2)} MB → ${(cardResult.totalThumb/1024).toFixed(1)} KB`);
  console.log(`  Token: ${tokenResult.count} 张, ${(tokenResult.totalOriginal/1024).toFixed(1)} KB → ${(tokenResult.totalThumb/1024).toFixed(1)} KB`);
  console.log("=========================================");
  console.log("完成。");
})().catch((e) => {
  console.error("生成失败:", e);
  process.exit(1);
});
