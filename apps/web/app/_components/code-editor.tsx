"use client";
import Editor, { loader, type EditorProps, type OnMount } from "@monaco-editor/react";

/**
 * Monaco-editor van het panel. Monaco komt uit public/monaco/vs (gekopieerd door copy-monaco.mjs bij dev/build),
 * niet van een CDN: de CSP staat voor scripts, styles en fonts alleen 'self' toe. Monaco zelf laadt pas als
 * er een editor opent (AMD-loader + chunks op aanvraag); in de app-bundle zit alleen de kleine React-wrapper.
 */
export const MONACO_VS_PATH = "/monaco/vs";
loader.config({ paths: { vs: MONACO_VS_PATH } });

export type { OnMount };
export function CodeEditor(props: EditorProps) {
  return <Editor {...props} />;
}
