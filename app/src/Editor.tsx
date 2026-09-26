import { useEffect, useRef } from "preact/hooks";
import type { MutableRef } from "preact/hooks";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";

export interface EditorApi {
  insert: (text: string) => void;
}

const ATTACHMENT = /\.(png|jpe?g|gif|webp|avif|svg|pdf|mp3|mp4|webm)$/i;
const pickFiles = (list?: FileList | null) => [...(list ?? [])].filter((f) => f.type.startsWith("image/") || f.type === "application/pdf" || ATTACHMENT.test(f.name));

export function Editor({
  value,
  onChange,
  onSave,
  onFiles,
  apiRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  /** pasted or dropped files; the parent uploads them and inserts links through apiRef */
  onFiles?: (files: File[]) => void;
  apiRef?: MutableRef<EditorApi | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef({ onChange, onSave, onFiles });
  cb.current = { onChange, onSave, onFiles };

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          markdown(),
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            paste: (e) => {
              const fs = pickFiles(e.clipboardData?.files);
              if (!fs.length || !cb.current.onFiles) return false;
              e.preventDefault();
              cb.current.onFiles(fs);
              return true;
            },
            drop: (e) => {
              const fs = pickFiles(e.dataTransfer?.files);
              if (!fs.length || !cb.current.onFiles) return false;
              e.preventDefault();
              cb.current.onFiles(fs);
              return true;
            },
          }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => u.docChanged && cb.current.onChange(u.state.doc.toString())),
        ],
      }),
    });
    if (apiRef) apiRef.current = { insert: (text) => (view.dispatch(view.state.replaceSelection(text)), view.focus()) };
    return () => {
      if (apiRef) apiRef.current = null;
      view.destroy();
    };
    // recreated per document (parent keys the component on path)
  }, []);

  return <div class="editor" ref={host} />;
}
