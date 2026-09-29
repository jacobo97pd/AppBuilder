import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import { build } from "esbuild";
import {
  getProject,
  httpError,
  isProtectedName,
  projectDir,
  protectedPath,
  readFile,
} from "./workspace.js";

const scriptSafe = (value: string) =>
  value.replace(/<\/script/gi, "<\\/script");
const styleSafe = (value: string) => value.replace(/<\/style/gi, "<\\/style");
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};
const beforeClosingTag = (
  html: string,
  tag: "head" | "body",
  content: string,
) => {
  const closing = new RegExp(`</${tag}\\s*>`, "i");
  return closing.test(html)
    ? html.replace(closing, (match) => content + match)
    : tag === "head"
      ? content + html
      : html + content;
};
const bridge = `<script>(()=>{for(const level of ['log','warn','error']){const original=console[level];console[level]=(...args)=>{original.apply(console,args);parent.postMessage({type:'appbuilder:console',level,text:args.map(a=>{try{return typeof a==='string'?a:JSON.stringify(a)}catch{return String(a)}}).join(' ').slice(0,4000)},'*')}}window.addEventListener('error',e=>parent.postMessage({type:'appbuilder:console',level:'error',text:e.message},'*'));window.addEventListener('unhandledrejection',e=>parent.postMessage({type:'appbuilder:console',level:'error',text:String(e.reason)},'*'))})();</script>`;

export async function renderPreview(
  projectId: string,
): Promise<{ html: string; updatedAt: string; kind: string }> {
  const project = getProject(projectId);
  const root = projectDir(projectId);
  const realRoot = fs.realpathSync(root);
  const libraryRoot = fs.realpathSync(path.resolve("node_modules"));
  let html = readFile(projectId, "index.html").content;
  if (project.template === "react") {
    const result = await build({
      absWorkingDir: root,
      entryPoints: ["src/main.jsx"],
      bundle: true,
      write: false,
      outdir: "preview",
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      // A project must not cause esbuild to read a tsconfig from an ancestor.
      tsconfigRaw: {},
      define: { "process.env.NODE_ENV": '"development"' },
      nodePaths: [path.resolve("node_modules")],
      loader: {
        ".png": "dataurl",
        ".jpg": "dataurl",
        ".svg": "dataurl",
        ".woff2": "dataurl",
      },
      logLevel: "silent",
      plugins: [
        {
          name: "workspace-boundary",
          setup(bundler) {
            bundler.onLoad({ filter: /.*/ }, (args) => {
              if (args.namespace !== "file") return undefined;
              const resolved = fs.realpathSync(args.path);
              const local = inside(realRoot, resolved);
              const library = inside(libraryRoot, resolved);
              if (!local && !library)
                return {
                  errors: [{ text: "La importación sale del proyecto." }],
                };
              const relative = path.relative(
                local ? realRoot : libraryRoot,
                resolved,
              );
              const parts = relative.split(path.sep);
              // Dependencies may be bundled, but their credential and metadata
              // files are never eligible, even beneath a node_modules directory.
              if (
                parts.some(
                  (part) => part !== "node_modules" && isProtectedName(part),
                )
              )
                return {
                  errors: [
                    { text: "La importación contiene un archivo protegido." },
                  ],
                };
              if (local && !parts.includes("node_modules"))
                protectedPath(projectId, relative);
              if (
                !fs.statSync(resolved).isFile() ||
                fs.statSync(resolved).size > 8 * 1024 * 1024
              )
                return {
                  errors: [
                    {
                      text: "El archivo de la vista previa es demasiado grande o no es válido.",
                    },
                  ],
                };
              return undefined;
            });
          },
        },
      ],
    }).catch(() => {
      // esbuild diagnostics can include source excerpts and absolute paths from
      // package resolution. Do not serialize these back to an untrusted preview.
      throw httpError(
        400,
        "No se pudo compilar la vista previa. Revisa la sintaxis y las importaciones; solo se permiten archivos del proyecto y sus dependencias, sin credenciales.",
      );
    });
    html = html.replace(
      /<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>/gi,
      "",
    );
    for (const output of result.outputFiles ?? []) {
      if (output.path.endsWith(".css"))
        html = beforeClosingTag(
          html,
          "head",
          `<style>${styleSafe(output.text)}</style>`,
        );
      if (output.path.endsWith(".js"))
        html = beforeClosingTag(
          html,
          "body",
          `<script>${scriptSafe(output.text)}</script>`,
        );
    }
  } else {
    html = html.replace(
      /<link\b([^>]*?)href=["']([^"']+)["']([^>]*?)>/gi,
      (full, before: string, href: string, after: string) => {
        if (
          !/stylesheet/i.test(before + after) ||
          /^(https?:|data:|\/\/)/i.test(href)
        )
          return full;
        return `<style>${styleSafe(readFile(projectId, href.replace(/^\.\//, "").replace(/^\//, "")).content)}</style>`;
      },
    );
    const scripts = [
      ...html.matchAll(
        /<script\b([^>]*?)src=["']([^"']+)["']([^>]*?)>\s*<\/script>/gi,
      ),
    ];
    for (const match of scripts) {
      const src = match[2];
      if (/^(https?:|data:|\/\/)/i.test(src)) continue;
      const file = src.replace(/^\.\//, "").replace(/^\//, "");
      html = html.replace(
        match[0],
        `<script>${scriptSafe(readFile(projectId, file).content)}</script>`,
      );
    }
  }
  // srcdoc is always displayed in an opaque-origin sandbox. No host session/code access.
  // Prepend the policy before any project markup, including malformed documents
  // without a head. An additional project CSP can only restrict this policy.
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src https:; form-action 'none'; base-uri 'none';">`;
  html = `<!doctype html>${policy}${bridge}${html.replace(/^\s*<!doctype[^>]*>/i, "")}`;
  return { html, updatedAt: new Date().toISOString(), kind: project.template };
}

export function createPreviewRouter() {
  const router = Router();
  router.get("/projects/:id/preview", async (req, res, next) => {
    try {
      res.json(await renderPreview(req.params.id));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
