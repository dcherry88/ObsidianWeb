import { useEffect, useRef } from "preact/hooks";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";

export function Editor({ value, onChange, onSave }: { value: string; onChange: (v: string) => void; onSave: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

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
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => u.docChanged && cb.current.onChange(u.state.doc.toString())),
        ],
      }),
    });
    return () => view.destroy();
    // recreated per document (parent keys the component on path)
  }, []);

  return <div class="editor" ref={host} />;
}
