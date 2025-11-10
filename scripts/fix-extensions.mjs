import fs from "fs";
import path from "path";

const distDir = path.resolve("dist");
const modified = [];

function fixFile(filePath) {
  let code = fs.readFileSync(filePath, "utf8");
  let newCode = code.replace(
    /(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (match, start, rel, end) => {
      if (
        rel.endsWith(".js") ||
        rel.endsWith(".json") ||
        rel.startsWith("node:") ||
        rel.startsWith("@") ||
        rel.startsWith("/") ||
        rel.includes("chalk") ||
        rel.includes("commander")
      ) {
        return match;
      }
      return `${start}${rel}.js${end}`;
    }
  );

  if (newCode !== code) {
    fs.writeFileSync(filePath, newCode);
    modified.push(filePath);
  }
}

function walk(dir) {
  for (const file of fs.readdirSync(dir)) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full);
    else if (file.endsWith(".js")) fixFile(full);
  }
}

walk(distDir);
console.log(`✅ Fixed .js extensions in ${modified.length} files`);
if (modified.length) console.log(modified.join("\n"));
