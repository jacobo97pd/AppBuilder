import { useEffect, useRef, useState } from "react";
import { FileText, ImageOff, X } from "lucide-react";
import { errorMessage, protectedFileUrl, rememberFileUrl, upload } from "./api";
import type { Attachment, ToastFn } from "./types";
import { Modal, Spinner } from "./ui";

export const MAX_ATTACHMENTS = 10;
const MAX_BYTES = 20 * 1024 * 1024;
// Big enough to read any screenshot, small enough to upload quickly.
const MAX_IMAGE_SIDE = 2048;

/** An uploaded attachment, with a local preview while the message is a draft. */
export type DraftAttachment = Attachment & { preview?: string };
type Upload = { id: string; name: string; preview?: string };

export const isImage = (file: { type: string }) =>
  /^image\/(png|jpeg|gif|webp)$/.test(file.type);

const fileAddress = (projectId: string, file: Attachment) =>
  `/projects/${projectId}/attachments/${file.path.split("/").pop()}`;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

/**
 * Large photos are reduced and HEIC photos become JPEG, which every agent can
 * read and phones upload quickly. Anything else is sent unchanged.
 */
export async function prepareUpload(
  file: File,
): Promise<{ blob: Blob; name: string }> {
  const heic =
    /^image\/hei[cf]$/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
  const resizable = heic || /^image\/(png|jpeg|webp)$/i.test(file.type);
  if (!resizable || typeof createImageBitmap !== "function")
    return { blob: file, name: file.name };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { blob: file, name: file.name };
  }
  const scale = Math.min(
    1,
    MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height),
  );
  if (scale === 1 && !heic && file.size <= 4 * 1024 * 1024) {
    bitmap.close();
    return { blob: file, name: file.name };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return { blob: file, name: file.name };
  }
  // JPEG has no transparency; paint it on white instead of black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.88),
  );
  if (!blob) return { blob: file, name: file.name };
  return {
    blob,
    name: `${file.name.replace(/\.[^.]*$/, "") || "imagen"}.jpg`,
  };
}

/** Uploads files to the project's attachments while the message is written. */
export function useAttachmentUploads(
  projectId: string,
  attached: number,
  onUploaded: (file: DraftAttachment) => void,
  notify: ToastFn,
) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const pending = useRef(0);
  async function add(list: File[]) {
    if (!list.length) return;
    const room = MAX_ATTACHMENTS - attached - pending.current;
    if (room <= 0) {
      notify(
        `Puedes adjuntar hasta ${MAX_ATTACHMENTS} archivos por mensaje.`,
        "error",
      );
      return;
    }
    if (list.length > room)
      notify(
        `Solo caben ${room} archivos más: el límite es ${MAX_ATTACHMENTS} por mensaje.`,
        "error",
      );
    const files = list.slice(0, room);
    pending.current += files.length;
    await Promise.all(
      files.map(async (file) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const preview = file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined;
        setUploads((current) => [...current, { id, name: file.name, preview }]);
        try {
          const { blob, name } = await prepareUpload(file);
          if (blob.size > MAX_BYTES)
            throw new Error(`${file.name} supera el límite de 20 MB.`);
          const saved = await upload<Attachment>(
            `/projects/${projectId}/attachments`,
            blob,
            name,
          );
          if (preview) rememberFileUrl(fileAddress(projectId, saved), preview);
          onUploaded({ ...saved, preview });
        } catch (e) {
          if (preview) URL.revokeObjectURL(preview);
          notify(errorMessage(e), "error");
        } finally {
          pending.current--;
          setUploads((current) => current.filter((item) => item.id !== id));
        }
      }),
    );
  }
  return { uploads, add };
}

/** An attachment image; native apps need it fetched with their access key. */
export function ProtectedImage({
  address,
  src,
  alt,
  className,
}: {
  address: string;
  src?: string;
  alt: string;
  className?: string;
}) {
  const [url, setUrl] = useState(src ?? "");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (src) {
      setUrl(src);
      return;
    }
    let alive = true;
    protectedFileUrl(address).then(
      (value) => {
        if (alive) setUrl(value);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [address, src]);
  if (failed)
    return (
      <span className="attachment-icon" title="La imagen ya no está disponible">
        <ImageOff size={15} />
      </span>
    );
  return url ? (
    <img src={url} alt={alt} className={className} />
  ) : (
    <span className="attachment-icon loading" aria-hidden="true" />
  );
}

export function ComposerAttachments({
  projectId,
  files,
  uploads,
  onRemove,
}: {
  projectId: string;
  files: DraftAttachment[];
  uploads: Upload[];
  onRemove: (file: DraftAttachment) => void;
}) {
  if (!files.length && !uploads.length) return null;
  return (
    <ul className="prompt-attachments" aria-label="Archivos adjuntos">
      {files.map((file) => (
        <li key={file.path} className="attachment-chip">
          {isImage(file) ? (
            <ProtectedImage
              address={fileAddress(projectId, file)}
              src={file.preview}
              alt=""
            />
          ) : (
            <span className="attachment-icon">
              <FileText size={15} />
            </span>
          )}
          <span>
            <strong>{file.name}</strong>
            <small>{formatSize(file.size)}</small>
          </span>
          <button
            type="button"
            aria-label={`Quitar ${file.name}`}
            title="Quitar"
            onClick={() => onRemove(file)}
          >
            <X size={13} />
          </button>
        </li>
      ))}
      {uploads.map((item) => (
        <li key={item.id} className="attachment-chip uploading">
          {item.preview ? (
            <img src={item.preview} alt="" />
          ) : (
            <span className="attachment-icon">
              <FileText size={15} />
            </span>
          )}
          <span>
            <strong>{item.name}</strong>
            <small>Subiendo…</small>
          </span>
          <Spinner />
        </li>
      ))}
    </ul>
  );
}

/** Attachments shown with a sent message; images open full size. */
export function MessageAttachments({
  projectId,
  files,
}: {
  projectId: string;
  files?: Attachment[];
}) {
  const [open, setOpen] = useState<Attachment | null>(null);
  if (!files?.length) return null;
  return (
    <>
      <ul className="message-attachments" aria-label="Adjuntos del mensaje">
        {files.map((file) => (
          <li key={file.path}>
            {isImage(file) ? (
              <button
                type="button"
                className="message-image"
                aria-label={`Ver ${file.name}`}
                onClick={() => setOpen(file)}
              >
                <ProtectedImage
                  address={fileAddress(projectId, file)}
                  alt={file.name}
                />
              </button>
            ) : (
              <span className="message-file">
                <FileText size={13} />
                {file.name}
              </span>
            )}
          </li>
        ))}
      </ul>
      {open && (
        <Modal
          wide
          title={open.name}
          subtitle={formatSize(open.size)}
          onClose={() => setOpen(null)}
        >
          <ProtectedImage
            address={fileAddress(projectId, open)}
            alt={open.name}
            className="attachment-full"
          />
        </Modal>
      )}
    </>
  );
}
