import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "appbuilder-repositories-test-"),
);
process.env.APPBUILDER_DATA_DIR = path.join(testRoot, "data");
delete process.env.GITHUB_TOKEN;
const workspace = await import("./workspace.js");
const jobs = await import("./jobs.js");
const core = await import("./core.js");
const repositories = await import("./repositories.js");
const remotes = await import("./remotes.js");

const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

function createRemote(name: string): string {
  const source = path.join(testRoot, `${name}-source`);
  const bare = path.join(testRoot, `${name}.git`);
  fs.mkdirSync(path.join(source, "Assets"), { recursive: true });
  git(source, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(source, "README.md"), "# Juego\n");
  fs.writeFileSync(
    path.join(source, "Assets", "Player.cs"),
    "public class Player {}\n",
  );
  git(source, ["add", "."]);
  git(source, [...identity, "commit", "-m", "Inicio"]);
  git(testRoot, ["clone", "--bare", source, bare]);
  return bare;
}

async function settle(id: string) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const job = jobs.getJob(id);
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("La tarea de Git no terminó a tiempo.");
}

after(async () => {
  for (const project of workspace.listProjects())
    for (const job of jobs.listJobs(project.id))
      if (job.status === "running") await jobs.cancelJob(job.id);
  const resolved = path.resolve(testRoot);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved), /^appbuilder-repositories-test-/);
  fs.rmSync(resolved, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
});

test("normaliza direcciones de GitHub y rechaza transportes inseguros", () => {
  assert.deepEqual(remotes.normalizeRepositoryUrl("octocat/Hello-World"), {
    url: "https://github.com/octocat/Hello-World.git",
    label: "octocat/Hello-World",
    name: "Hello-World",
    github: true,
  });
  assert.equal(
    remotes.normalizeRepositoryUrl(
      "https://github.com/octocat/Hello-World/tree/main",
    ).url,
    "https://github.com/octocat/Hello-World.git",
  );
  assert.equal(
    remotes.normalizeRepositoryUrl("github.com/a/b.git").label,
    "a/b",
  );
  assert.equal(
    remotes.normalizeRepositoryUrl("https://gitlab.com/grupo/sub/proyecto.git")
      .url,
    "https://gitlab.com/grupo/sub/proyecto.git",
  );
  for (const unsafe of [
    "http://github.com/a/b",
    "git@github.com:a/b.git",
    "ext::sh -c touch% /tmp/pwned",
    "file:///etc/passwd",
    "https://user:secret@github.com/a/b",
    "https://github.com/a",
    "https://github.com/a/b?ref=main",
    "C:\\repos\\juego",
    "--upload-pack=touch",
  ])
    assert.throws(
      () => remotes.normalizeRepositoryUrl(unsafe),
      (error: Error & { status?: number }) => error.status === 400,
      unsafe,
    );
  assert.equal(
    remotes.publicRemoteUrl("https://token-value@github.com/a/b.git"),
    "https://github.com/a/b.git",
  );
  assert.equal(remotes.remoteLabel("git@github.com:a/b.git"), "a/b");
  assert.equal(
    remotes.remoteWebUrl("git@github.com:a/b.git"),
    "https://github.com/a/b",
  );
});

test("el token de GitHub viaja como cabecera temporal y solo hacia GitHub", () => {
  const token = "ghp_testtoken1234567890";
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  const env = repositories.gitRemoteEnvironment(
    "https://github.com/a/b.git",
    token,
  );
  const count = Number(env.GIT_CONFIG_COUNT);
  const config = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      env[`GIT_CONFIG_KEY_${index}`],
      env[`GIT_CONFIG_VALUE_${index}`],
    ]),
  );
  assert.equal(
    config["http.https://github.com/.extraheader"],
    `AUTHORIZATION: basic ${encoded}`,
  );
  assert.equal(config["credential.interactive"], "never");
  assert.equal(env.GCM_INTERACTIVE, "never");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  const elsewhere = repositories.gitRemoteEnvironment(
    "https://gitlab.com/a/b.git",
    token,
  );
  assert.ok(!JSON.stringify(elsewhere).includes(encoded));
  assert.ok(!JSON.stringify(elsewhere).includes(token));
});

test("resume el progreso de Git y explica los fallos habituales", () => {
  const lines: string[] = [];
  const write = repositories.gitProgress((text) => lines.push(text));
  write(
    "Cloning into 'juego'...\nReceiving objects:   1% (1/100)\rReceiving objects:  10% (10/100)\rReceiving objects:  45% (45/100)\r",
  );
  write(
    "Receiving objects: 100% (100/100), done.\nResolving deltas: 100% (5/5), done.\n",
  );
  write.flush();
  assert.deepEqual(lines, [
    "Cloning into 'juego'...\n",
    "Receiving objects:   1% (1/100)\n",
    "Receiving objects:  45% (45/100)\n",
    "Receiving objects: 100% (100/100), done.\n",
    "Resolving deltas: 100% (5/5), done.\n",
  ]);
  assert.match(
    repositories.explainGitFailure(
      "remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found",
    ),
    /No se encontró el repositorio/,
  );
  assert.match(
    repositories.explainGitFailure(
      " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs",
    ),
    /Traer cambios/,
  );
  assert.match(
    repositories.explainGitFailure(
      "fatal: Not possible to fast-forward, aborting.",
    ),
    /commits distintos/,
  );
  assert.equal(
    repositories.explainGitFailure("Receiving objects: 403/1000"),
    "",
  );
});

test("importa un repositorio, lo sincroniza en ambos sentidos y no deja restos si falla", async () => {
  const bare = createRemote("juego");
  const { project, job } = repositories.startImport(
    { url: bare, name: "Juego" },
    { allowLocalSources: true },
  );
  assert.equal(project.template, "repo");
  assert.ok(
    !workspace.listProjects().some((item) => item.id === project.id),
    "Un proyecto que se está importando no aparece en la lista",
  );
  const imported = await settle(job.id);
  assert.equal(imported.status, "succeeded", imported.output);
  const ready = workspace.getProject(project.id);
  assert.equal(ready.importing, undefined);
  assert.equal(ready.source?.branch, "main");
  assert.ok(
    workspace
      .listFiles(project.id)
      .some((entry) => entry.path === "Assets/Player.cs"),
  );
  let status = await core.getGitStatus(project.id);
  assert.ok(status.remote?.upstream);
  assert.equal(status.remote?.ahead, 0);
  assert.equal(status.remote?.behind, 0);

  workspace.writeFile(project.id, "Assets/Enemy.cs", "public class Enemy {}\n");
  await core.createCheckpoint(project.id, "Añadir enemigo");
  status = await core.getGitStatus(project.id);
  assert.equal(status.remote?.ahead, 1);
  const pushed = await settle(repositories.startSync(project.id, "push").id);
  assert.equal(pushed.status, "succeeded", pushed.output);
  assert.match(
    git(bare, ["log", "-1", "--format=%s", "main"]),
    /Añadir enemigo/,
  );
  assert.equal((await core.getGitStatus(project.id)).remote?.ahead, 0);

  const other = path.join(testRoot, "otra-copia");
  git(testRoot, ["clone", bare, other]);
  fs.writeFileSync(path.join(other, "NOTES.md"), "Nota\n");
  git(other, ["add", "."]);
  git(other, [...identity, "commit", "-m", "Nota remota"]);
  git(other, ["push", "origin", "main"]);
  await repositories.fetchRemote(project.id);
  assert.equal((await core.getGitStatus(project.id)).remote?.behind, 1);
  const pulled = await settle(repositories.startSync(project.id, "pull").id);
  assert.equal(pulled.status, "succeeded", pulled.output);
  // core.autocrlf may turn the line ending into CRLF on Windows checkouts.
  assert.equal(
    workspace.readFile(project.id, "NOTES.md").content.replace(/\r\n/g, "\n"),
    "Nota\n",
  );

  const sync = jobs.createJob(project.id, "git", "Sincronización simulada");
  workspace.writeFile(project.id, "Assets/Enemy.cs", "public class Boss {}\n");
  await assert.rejects(
    core.createCheckpoint(project.id, "No durante la sincronización"),
    (error: Error & { status?: number }) => error.status === 409,
  );
  jobs.finishJob(sync.id, "succeeded");
  const agent = jobs.createJob(project.id, "agent", "Agente simulado");
  assert.throws(
    () => repositories.startSync(project.id, "push"),
    (error: Error & { status?: number }) => error.status === 409,
  );
  jobs.finishJob(agent.id, "succeeded");

  const failed = repositories.startImport(
    { url: path.join(testRoot, "no-existe.git") },
    { allowLocalSources: true },
  );
  assert.equal((await settle(failed.job.id)).status, "failed");
  assert.throws(
    () => workspace.getProject(failed.project.id),
    (error: Error & { status?: number }) => error.status === 404,
  );
  assert.ok(
    !fs.existsSync(path.join(testRoot, "data", "projects", failed.project.id)),
  );

  workspace.deleteProject(project.id);
  assert.throws(() => workspace.getProject(project.id));
  assert.ok(
    !fs.existsSync(path.join(testRoot, "data", "projects", project.id)),
  );
});

test("limpia importaciones interrumpidas y no vuelve a crear el ejemplo", () => {
  const reserved = workspace.reserveImportedProject({
    name: "Parcial",
    url: "https://github.com/a/b.git",
  });
  fs.mkdirSync(reserved.directory);
  fs.writeFileSync(path.join(reserved.directory, "partial"), "");
  workspace.cleanupInterruptedImports();
  assert.throws(() => workspace.getProject(reserved.project.id));
  assert.ok(!fs.existsSync(reserved.directory));
  for (const project of workspace.listProjects())
    workspace.deleteProject(project.id);
  assert.deepEqual(workspace.listProjects(), []);
});
