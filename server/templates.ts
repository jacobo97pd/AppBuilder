/** Flutter apps come from `flutter create` in a job, not from files here. */
export type ProjectTemplate = "web" | "react" | "flutter";

const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#10111a" />
    <title>Orbit Notes</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="shell">
      <header><a class="brand" href="#">✳ <span>orbit<span class="muted">notes</span></span></a><span class="pill">TU ESPACIO PERSONAL</span></header>
      <section class="hero"><div class="eyebrow">ESPACIO PARA LO QUE VIENE</div><h1>Las grandes ideas<br>empiezan <span>aquí.</span></h1><p>Un lugar tranquilo para pensar, crear y dar forma<br class="desktop"> a tu próxima gran idea.</p></section>
      <form id="note-form"><label class="sr-only" for="note-input">Escribe una idea</label><input id="note-input" placeholder="¿Qué tienes en mente?" maxlength="500" required><button type="submit">Guardar idea <span>↗</span></button></form>
      <div class="section-heading"><h2>Tus ideas <span id="count"></span></h2><span>Un pequeño paso, cada día.</span></div>
      <section id="notes" class="notes" aria-label="Ideas guardadas"></section>
      <footer>HECHO PARA MENTES CURIOSAS <span>✦</span> CREA ALGO QUE IMPORTE</footer>
    </main>
    <script src="app.js"></script>
  </body>
</html>`;

const css = `@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap');
:root{color-scheme:dark;font-family:'DM Sans',system-ui,sans-serif;color:#f4f3f9;background:#10111a;font-synthesis:none}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 83% 0%,#29214080,transparent 50%);min-height:100vh}.shell{max-width:1000px;margin:auto;padding:35px 42px}header{display:flex;justify-content:space-between;align-items:center}.brand{color:#b3a0ff;text-decoration:none;font-size:31px;display:flex;align-items:center;gap:12px}.brand>span{font-size:20px;font-weight:700;letter-spacing:-.8px;color:#f2efff}.muted{font-weight:400;color:#8d8b9f}.pill{font-size:9px;letter-spacing:1.6px;color:#afabc3;border:1px solid #363044;border-radius:30px;padding:10px 13px}.hero{padding:78px 0 33px}.eyebrow{color:#aa92ed;font-size:10px;font-weight:600;letter-spacing:2px}h1{font-family:'Manrope',system-ui,sans-serif;font-size:clamp(39px,6.7vw,64px);letter-spacing:-3px;line-height:1.14;font-weight:700;margin:21px 0}h1 span{color:#bda9ff}p{color:#9290a5;line-height:1.8;font-size:14px}form{display:flex;gap:12px;padding:10px;background:#1c1b29;border:1px solid #343041;border-radius:13px}input{flex:1;min-width:0;border:0;background:transparent;padding:10px;color:#eee;font:inherit;outline:none;font-size:13px}input:focus-visible{outline:2px solid #b49aff;border-radius:5px}button{border:0;cursor:pointer;background:#bda4ff;color:#201334;border-radius:8px;padding:14px 18px;font:600 12px 'DM Sans',sans-serif}button:hover{background:#d0bcff}button span{padding-left:14px}.section-heading{display:flex;justify-content:space-between;align-items:center;margin:39px 0 18px}.section-heading h2{font-size:14px;font-weight:500;margin:0}.section-heading h2 span{font-size:10px;color:#a7a1bd;background:#242131;padding:4px 7px;border-radius:6px;margin-left:6px}.section-heading>span{color:#737085;font-size:10px}.notes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.note{position:relative;min-height:175px;border:1px solid #353040;background:linear-gradient(145deg,#22202f,#1b1a25);border-radius:12px;padding:20px}.note:nth-child(3n+2){background:linear-gradient(145deg,#202b2b,#191f23);border-color:#2c3b3b}.note:nth-child(3n){background:linear-gradient(145deg,#2c2623,#211e20);border-color:#3b3330}.note-icon{font-size:22px}.note p{font-size:12px;color:#d4cede;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;margin:17px 0 30px}.note time{position:absolute;bottom:17px;color:#777183;font-size:9px}.delete{position:absolute;top:12px;right:12px;padding:5px 8px;color:#aaa;background:transparent;font-size:16px}.delete:hover{color:#fff;background:#ffffff12}.empty{color:#999;font-size:13px;grid-column:1/-1;padding:30px;text-align:center;border:1px dashed #383343;border-radius:12px}footer{display:flex;justify-content:center;align-items:center;gap:17px;padding:45px 0 12px;font-size:8px;letter-spacing:1.3px;color:#625d74}footer span{color:#8f78bc;font-size:15px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:600px){.shell{padding:25px 22px}.pill{font-size:7px;padding:8px}.hero{padding-top:57px}h1{letter-spacing:-2px}.notes{grid-template-columns:1fr}.note{min-height:150px}.section-heading>span{display:none}button{padding:12px}.desktop{display:none}footer{font-size:6px;gap:10px}}
`;

const javascript = `const storageKey = 'orbit-notes-v1';
const initialNotes = [
  { id: '1', text: 'Una app para capturar las ideas que aparecen cuando menos las esperas.', icon: '✦', date: 'HOY' },
  { id: '2', text: 'Menos ruido. Más espacio para crear algo que merezca la pena.', icon: '◈', date: 'HOY' },
  { id: '3', text: '¿Y si el próximo proyecto empieza con una sola nota?', icon: '☀', date: 'HOY' }
];
let notes = initialNotes;
try { const saved = JSON.parse(localStorage.getItem(storageKey)); if (Array.isArray(saved)) notes = saved.filter(note => typeof note.text === 'string' && typeof note.id === 'string'); } catch {}
const container = document.querySelector('#notes');
function render() {
  container.replaceChildren();
  document.querySelector('#count').textContent = notes.length;
  if (!notes.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Tu próxima idea puede empezar aquí. Escribe la primera.'; container.append(empty); }
  notes.forEach(note => {
    const article = document.createElement('article'); article.className = 'note';
    const icon = document.createElement('span'); icon.className = 'note-icon'; icon.textContent = note.icon || '✦';
    const text = document.createElement('p'); text.textContent = note.text;
    const date = document.createElement('time'); date.textContent = note.date || 'HOY';
    const remove = document.createElement('button'); remove.className = 'delete'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Eliminar idea');
    remove.addEventListener('click', () => { notes = notes.filter(item => item.id !== note.id); save(); });
    article.append(icon, text, date, remove); container.append(article);
  });
}
function save() { try { localStorage.setItem(storageKey, JSON.stringify(notes)); } catch {} render(); }
document.querySelector('#note-form').addEventListener('submit', event => {
  event.preventDefault(); const input = document.querySelector('#note-input'); const value = input.value.trim(); if (!value) return;
  notes.unshift({ id: crypto.randomUUID(), text: value, icon: ['✦', '◈', '☀'][notes.length % 3], date: new Date().toLocaleDateString('es', { day: 'numeric', month: 'short' }).toUpperCase() });
  input.value = ''; save(); input.focus();
});
render();
`;

export function templateFiles(
  template: ProjectTemplate,
): Record<string, string> {
  const files: Record<string, string> = {
    ".gitignore": "node_modules/\ndist/\n.env\n.env.*\n*.log\n",
    ".gitattributes": "* text=auto eol=lf\n",
    "README.md":
      "# Orbit Notes\n\nTu espacio para guardar ideas. Edita los archivos y abre la vista previa.\n\nLas notas se guardan en el almacenamiento local cuando el navegador lo permite. En la vista previa aislada se conservan en memoria y se reinician al recargar.\n",
  };
  if (template === "web")
    return {
      ...files,
      "index.html": html,
      "styles.css": css,
      "app.js": javascript,
    };
  return {
    ...files,
    "index.html":
      '<!doctype html>\n<html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Mi app React</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n',
    "package.json":
      JSON.stringify(
        {
          name: "mi-app-react",
          private: true,
          version: "0.1.0",
          type: "module",
          scripts: {
            dev: "vite --host 127.0.0.1 --port 5174",
            build: "vite build",
            preview: "vite preview --host 127.0.0.1 --port 5174",
          },
          dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
          devDependencies: { vite: "^7.0.0" },
        },
        null,
        2,
      ) + "\n",
    "src/main.jsx": `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport './style.css';\n\ncreateRoot(document.getElementById('root')).render(<App />);\n`,
    "src/App.jsx": `import React, { useState } from 'react';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return <main><div className="badge">TU PRÓXIMA GRAN IDEA</div><h1>Todo empieza<br/><span>con un primer paso.</span></h1><p>Tu proyecto React está listo. Edita este archivo o pide ayuda a tu agente.</p><button onClick={() => setCount(count + 1)}>Has creado {count} {count === 1 ? 'posibilidad' : 'posibilidades'} ↗</button></main>;\n}\n`,
    "src/style.css": `:root{font-family:Inter,system-ui,sans-serif;color:#f1eefb;background:#10111a}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at top right,#49337b55,transparent 60%)}main{max-width:900px;margin:auto;padding:100px 30px}.badge{color:#bba0ff;font-size:11px;letter-spacing:3px}h1{font-size:clamp(36px,7vw,68px);line-height:1.12;letter-spacing:-3px}h1 span{color:#c2a9ff}p{color:#9d96b2;line-height:1.8;max-width:470px}button{margin-top:24px;padding:16px 22px;background:#bda4ff;border:0;border-radius:12px;color:#211532;font-weight:600;cursor:pointer}\n`,
    "README.md":
      "# Mi app React\n\nEdita `src/App.jsx` y abre la vista previa para ver tus cambios.\n\nPara instalar dependencias adicionales: `npm install`. Para generar una build: `npm run build`. Para un servidor de desarrollo: `npm run dev`. La terminal se ejecuta en la máquina del servidor.\n",
  };
}
