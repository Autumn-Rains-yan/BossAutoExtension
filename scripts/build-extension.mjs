import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const packageJsonPath = path.join(rootDir, "package.json");
const manifestPath = path.join(rootDir, "extension", "manifest.json");
const extensionDir = path.join(rootDir, "extension");
const distDir = path.join(rootDir, "dist");
const unpackedDir = path.join(distDir, "unpacked");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function ensureVersionConsistency(pkg, manifest) {
  if (pkg.version !== manifest.version) {
    throw new Error(
      `package.json 版本 ${pkg.version} 与 manifest.json 版本 ${manifest.version} 不一致，请先同步版本号。`
    );
  }
}

function cleanDist() {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(unpackedDir, { recursive: true });
}

function copyExtension() {
  cpSync(extensionDir, unpackedDir, {
    recursive: true,
    force: true,
  });
}

function resolveZipBinary() {
  const probe = spawnSync("zip", ["-v"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  return probe.status === 0 ? "zip" : null;
}

function createZipFromUnpacked(zipFilePath) {
  if (process.platform === "win32") {
    const powershell = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path * -DestinationPath '${zipFilePath.replace(/'/g, "''")}' -Force`,
      ],
      {
        cwd: unpackedDir,
        stdio: "inherit",
      }
    );

    if (powershell.status !== 0) {
      throw new Error("使用 PowerShell 打包 ZIP 失败。");
    }
    return;
  }

  const zipBinary = resolveZipBinary();
  if (!zipBinary) {
    throw new Error("当前环境缺少 zip 命令，无法生成 ZIP 包。");
  }

  const zipResult = spawnSync(zipBinary, ["-qr", zipFilePath, "."], {
    cwd: unpackedDir,
    stdio: "inherit",
  });

  if (zipResult.status !== 0) {
    throw new Error("生成 ZIP 包失败。");
  }
}

function listPackedFiles() {
  return readdirSync(unpackedDir, { withFileTypes: true })
    .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
    .join("\n");
}

function main() {
  const pkg = readJson(packageJsonPath);
  const manifest = readJson(manifestPath);
  const shouldZip = process.argv.includes("--zip");
  const artifactBaseName = `${pkg.name}-v${pkg.version}`;
  const zipFilePath = path.join(distDir, `${artifactBaseName}.zip`);

  ensureVersionConsistency(pkg, manifest);
  cleanDist();
  copyExtension();

  console.log(`已生成解压目录：${path.relative(rootDir, unpackedDir)}`);
  console.log("包含文件：");
  console.log(listPackedFiles());

  if (!existsSync(path.join(unpackedDir, "manifest.json"))) {
    throw new Error("打包结果中缺少 manifest.json。");
  }

  if (!shouldZip) {
    return;
  }

  createZipFromUnpacked(zipFilePath);
  console.log(`已生成发布包：${path.relative(rootDir, zipFilePath)}`);
}

main();
