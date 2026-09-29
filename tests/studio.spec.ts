import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

type Project = { id: string; name: string };

async function noPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(
    dimensions.document,
    "The document must not scroll horizontally",
  ).toBeLessThanOrEqual(dimensions.width + 1);
}

async function openStudio(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Las grandes ideas/ }),
  ).toBeVisible();
}

async function navigate(page: Page, name: string) {
  const navigation =
    page.viewportSize()!.width < 700
      ? page.locator(".mobile-nav")
      : page.locator(".sidebar nav");
  await navigation.getByRole("button", { name, exact: true }).click();
}

async function newProject(page: Page, name: string, template: "web" | "react") {
  await page
    .locator("main")
    .getByRole("button", { name: "Nuevo proyecto", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nombre del proyecto").fill(name);
  if (template === "react")
    await dialog.getByRole("button", { name: /React \+ Vite/ }).click();
  await dialog
    .getByRole("button", { name: "Crear proyecto", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".cm-content")).toBeVisible();
  const projects = (await (
    await page.request.get("/api/projects")
  ).json()) as Project[];
  return projects.find((project) => project.name === name)!;
}

const tab = (page: Page, name: string) =>
  page.locator(".workspace-tabs").getByRole("button", { name, exact: true });
const preview = (page: Page) =>
  page.frameLocator('iframe[title="Vista previa del proyecto"]');

test("seed project, working static preview and opaque sandbox", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openStudio(page);
  await noPageOverflow(page);
  fs.mkdirSync(".cache", { recursive: true });
  if (testInfo.project.name === "desktop") {
    await page.screenshot({ path: ".cache/desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: ".cache/mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page
    .locator(".project-card")
    .filter({
      has: page.getByRole("heading", { name: "Orbit Notes", exact: true }),
    })
    .click();
  await expect(page.locator(".active-file-tab")).toContainText("index.html");
  await expect(page.locator(".cm-content")).toContainText("Orbit Notes");
  await noPageOverflow(page);
  if (testInfo.project.name === "desktop")
    await page.screenshot({ path: ".cache/workspace.png", fullPage: true });
  await tab(page, "Vista previa").click();
  await expect(
    preview(page).getByRole("heading", { name: /Las grandes ideas/ }),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-forms",
  );
  if (testInfo.project.name === "mobile")
    await page.screenshot({
      path: ".cache/preview-mobile.png",
      fullPage: true,
    });
  await preview(page)
    .getByLabel("Escribe una idea")
    .fill("Idea desde una preview aislada");
  await preview(page)
    .getByRole("button", { name: /Guardar idea/ })
    .click();
  await expect(
    preview(page).getByText("Idea desde una preview aislada", { exact: true }),
  ).toBeVisible();

  const frame = await page
    .locator("iframe")
    .elementHandle()
    .then((element) => element!.contentFrame());
  const isolation = await frame!.evaluate(async () => {
    let parentBlocked = false;
    let storageBlocked = false;
    let apiBlocked = false;
    try {
      void parent.document.cookie;
    } catch {
      parentBlocked = true;
    }
    try {
      void localStorage.length;
    } catch {
      storageBlocked = true;
    }
    try {
      const response = await fetch("/api/projects", { credentials: "include" });
      apiBlocked = !response.ok;
    } catch {
      apiBlocked = true;
    }
    return { parentBlocked, storageBlocked, apiBlocked };
  });
  expect(isolation).toEqual({
    parentBlocked: true,
    storageBlocked: true,
    apiBlocked: true,
  });
  await noPageOverflow(page);
  expect(errors).toEqual([]);
});

test("edit, save, preview, inspect diff, commit and execute a real command", async ({
  page,
}, testInfo) => {
  await openStudio(page);
  const project = await newProject(
    page,
    `Editor ${testInfo.project.name}`,
    "web",
  );
  const original = await (
    await page.request.get(`/api/projects/${project.id}/file?path=index.html`)
  ).json();
  const marker = `Cambio comprobado ${testInfo.project.name}`;
  const edited = original.content.replace("Las grandes ideas", marker);
  await page.locator('.cm-content[contenteditable="true"]').fill(edited);
  await expect(page.locator(".workspace-save-status")).toContainText(
    "Sin guardar",
  );
  await noPageOverflow(page);
  await page
    .getByRole("button", { name: "Guardar archivo", exact: true })
    .click();
  await expect(page.locator(".workspace-save-status")).toContainText(
    "Guardado",
  );
  expect(
    (
      await (
        await page.request.get(
          `/api/projects/${project.id}/file?path=index.html`,
        )
      ).json()
    ).content,
  ).toContain(marker);

  await tab(page, "Vista previa").click();
  await expect(
    preview(page).getByRole("heading", { name: new RegExp(marker) }),
  ).toBeVisible();
  await noPageOverflow(page);
  await tab(page, "Cambios").click();
  await page
    .locator(".git-files")
    .getByRole("button", { name: /index.html/ })
    .click();
  await expect(page.locator(".git-diff")).toContainText(marker);
  const message = `Verificar edición ${testInfo.project.name}`;
  await page.getByLabel("Mensaje del commit").fill(message);
  await page
    .getByRole("button", { name: "Guardar commit", exact: true })
    .click();
  await expect(page.locator(".git-clean")).toBeVisible();
  const git = await (
    await page.request.get(`/api/projects/${project.id}/git`)
  ).json();
  expect(git.changes).toHaveLength(0);
  expect(git.log[0].message).toBe(message);

  await tab(page, "Terminal").click();
  const command = "node -e \"console.log('APPBUILDER_E2E_COMMAND_OK')\"";
  await page.getByLabel("Comando de terminal").fill(command);
  await page.getByLabel("Comando de terminal").press("Enter");
  await expect(page.locator(".terminal-output pre")).toContainText(
    "APPBUILDER_E2E_COMMAND_OK",
  );
  await expect(page.locator(".terminal-result")).toContainText("Completado");
  const jobs = await (
    await page.request.get(`/api/projects/${project.id}/jobs`)
  ).json();
  expect(
    jobs.some(
      (job: { status: string; exitCode: number; output: string }) =>
        job.status === "succeeded" &&
        job.exitCode === 0 &&
        job.output.includes("APPBUILDER_E2E_COMMAND_OK"),
    ),
  ).toBe(true);
  await noPageOverflow(page);
});

test("a failed save blocks sidebar navigation, preserves the draft and permits retry", async ({
  page,
}, testInfo) => {
  await openStudio(page);
  const project = await newProject(
    page,
    `Guardado protegido ${testInfo.project.name}`,
    "web",
  );
  const fileURL = `/api/projects/${project.id}/file`;
  const original = await (
    await page.request.get(fileURL + "?path=index.html")
  ).json();
  // Short content keeps the entire draft rendered by CodeMirror; longer files
  // virtualize lines and must be verified through the saved API response.
  const draft = `<!doctype html>\n<html><head><title>Borrador</title></head>\n<body><h1>NO PERDER ${testInfo.project.name}</h1></body></html>\n`;
  await page.locator('.cm-content[contenteditable="true"]').fill(draft);
  await expect(page.locator(".workspace-save-status")).toContainText(
    "Sin guardar",
  );
  await noPageOverflow(page);
  const routeURL = `**${fileURL}`;
  await page.route(routeURL, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Fallo temporal de guardado para esta prueba.",
          }),
        })
      : route.continue(),
  );

  const clickBuilds = async () => {
    if (testInfo.project.name === "mobile")
      await page
        .getByRole("button", { name: "Abrir menú", exact: true })
        .click();
    await page
      .locator(".sidebar nav")
      .getByRole("button", { name: "Builds", exact: true })
      .click();
  };
  await clickBuilds();
  const confirmation = page.getByRole("dialog", {
    name: "Conserva tus últimos cambios",
  });
  await expect(confirmation).toBeVisible();
  const failedRequest = page.waitForResponse(
    (response) =>
      response.url().endsWith(fileURL) && response.request().method() === "PUT",
  );
  await confirmation
    .getByRole("button", { name: "Guardar y continuar", exact: true })
    .click();
  expect((await failedRequest).status()).toBe(503);
  await expect(confirmation).toBeVisible();
  await expect(page.locator(".breadcrumbs")).toContainText(project.name);
  expect(
    (await (await page.request.get(fileURL + "?path=index.html")).json())
      .content,
  ).toBe(original.content);
  await confirmation
    .getByRole("button", { name: "Cerrar", exact: true })
    .click();
  if (testInfo.project.name === "mobile") {
    // The sidebar covers the scrim's center; tap its exposed right edge.
    await page
      .getByRole("button", { name: "Cerrar menú", exact: true })
      .click({ position: { x: page.viewportSize()!.width - 8, y: 80 } });
  }
  await expect(page.locator(".cm-content")).toContainText(
    `NO PERDER ${testInfo.project.name}`,
  );
  await expect(page.locator(".workspace-save-status")).toContainText(
    "Sin guardar",
  );
  await expect(
    page.getByRole("button", { name: "Guardar archivo", exact: true }),
  ).toBeEnabled();

  await page.unroute(routeURL);
  await clickBuilds();
  await confirmation
    .getByRole("button", { name: "Guardar y continuar", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /Listo para despegar/ }),
  ).toBeVisible();
  expect(
    (await (await page.request.get(fileURL + "?path=index.html")).json())
      .content,
  ).toBe(draft);
  await noPageOverflow(page);
});

test("an external file update returns 409 without overwriting either version", async ({
  page,
}, testInfo) => {
  await openStudio(page);
  const project = await newProject(
    page,
    `Conflicto ${testInfo.project.name}`,
    "web",
  );
  const fileURL = `/api/projects/${project.id}/file`;
  const original = await (
    await page.request.get(fileURL + "?path=index.html")
  ).json();
  const localDraft = `<!doctype html>\n<html><head><title>Borrador local</title></head>\n<body><h1>EDICIÓN LOCAL ${testInfo.project.name}</h1></body></html>\n`;
  const externalDraft = `<!doctype html>\n<html><head><title>Actualización externa</title></head>\n<body><h1>EDICIÓN EXTERNA ${testInfo.project.name}</h1></body></html>\n`;
  await page.locator('.cm-content[contenteditable="true"]').fill(localDraft);
  await expect(page.locator(".workspace-save-status")).toContainText(
    "Sin guardar",
  );
  const external = await page.request.put(fileURL, {
    headers: { "X-AppBuilder-Client": "studio" },
    data: {
      path: "index.html",
      content: externalDraft,
      expectedContent: original.content,
    },
  });
  expect(external.status()).toBe(200);
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(fileURL) && response.request().method() === "PUT",
  );
  await page
    .getByRole("button", { name: "Guardar archivo", exact: true })
    .click();
  expect((await conflict).status()).toBe(409);
  await expect(page.getByRole("status")).toContainText(
    "El archivo ha cambiado en el servidor",
  );
  await expect(page.locator(".cm-content")).toContainText(
    `EDICIÓN LOCAL ${testInfo.project.name}`,
  );
  await expect(page.locator(".workspace-save-status")).toContainText(
    "Sin guardar",
  );
  expect(
    (await (await page.request.get(fileURL + "?path=index.html")).json())
      .content,
  ).toBe(externalDraft);

  await page
    .getByRole("button", { name: "Recargar archivo", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Tienes cambios sin guardar",
  });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "Cerrar", exact: true })
    .click();
  await expect(page.locator(".cm-content")).toContainText(
    `EDICIÓN LOCAL ${testInfo.project.name}`,
  );
  await noPageOverflow(page);
});

test("new React project compiles and its UI handles state without runtime errors", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openStudio(page);
  await newProject(page, `React ${testInfo.project.name}`, "react");
  await expect(page.locator(".active-file-tab")).toContainText("App.jsx");
  await tab(page, "Vista previa").click();
  await expect(
    preview(page).getByRole("heading", { name: /Todo empieza/ }),
  ).toBeVisible();
  await preview(page)
    .getByRole("button", { name: /Has creado 0 posibilidades/ })
    .click();
  await expect(
    preview(page).getByRole("button", { name: /Has creado 1 posibilidad/ }),
  ).toBeVisible();
  await expect(page.locator(".preview-console .error")).toHaveCount(0);
  await noPageOverflow(page);
  expect(errors).toEqual([]);
});

test("missing credentials disable execution and builds, and offer real setup", async ({
  page,
}) => {
  await openStudio(page);
  await page
    .locator(".project-card")
    .filter({
      has: page.getByRole("heading", { name: "Orbit Notes", exact: true }),
    })
    .click();
  await tab(page, "Agente").click();
  await page
    .getByLabel("Mensaje al agente")
    .fill("No debe ejecutarse sin credenciales");
  await expect(
    page.getByRole("button", { name: "Enviar al agente", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".agent-connect-notice")).toContainText(
    "Conecta Codex",
  );
  await page
    .getByRole("button", { name: "Configurar agente", exact: true })
    .click();
  await expect(page.locator(".connection-card")).toHaveCount(6);
  await expect(
    page.locator(".connection-card").filter({ hasText: "Sin conectar" }),
  ).toHaveCount(6);
  await noPageOverflow(page);
  await navigate(page, "Builds");
  await expect(
    page.getByRole("button", { name: "Nueva build", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Conectar Codemagic", exact: true }),
  ).toBeVisible();
  await noPageOverflow(page);
});
