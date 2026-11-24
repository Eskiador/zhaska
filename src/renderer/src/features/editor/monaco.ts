/**
 * Monaco cargado 100 % en local (sin CDN) para que funcione sin conexión.
 * Este módulo se importa de forma diferida: Monaco no penaliza el arranque.
 */
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    return new EditorWorker()
  },
}

export const THEME = 'zhaska-dark'

monaco.editor.defineTheme(THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'C9CEDA' },
    { token: 'comment', foreground: '6C7386', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'C49BFF' },
    { token: 'string', foreground: '8FD19E' },
    { token: 'number', foreground: 'F0A070' },
    { token: 'type', foreground: 'E7C07B' },
    { token: 'type.identifier', foreground: 'E7C07B' },
    { token: 'identifier', foreground: 'C9CEDA' },
    { token: 'delimiter', foreground: '8C93A6' },
    { token: 'tag', foreground: '7FB2FF' },
    { token: 'attribute.name', foreground: 'E7C07B' },
    { token: 'attribute.value', foreground: '8FD19E' },
    { token: 'key', foreground: '7FB2FF' },
    { token: 'string.key.json', foreground: '7FB2FF' },
    { token: 'string.value.json', foreground: '8FD19E' },
  ],
  colors: {
    'editor.background': '#0F1218',
    'editor.foreground': '#C9CEDA',
    'editorLineNumber.foreground': '#3E4556',
    'editorLineNumber.activeForeground': '#A0A7B8',
    'editor.lineHighlightBackground': '#151922',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#4F7DFF40',
    'editor.inactiveSelectionBackground': '#4F7DFF22',
    'editorCursor.foreground': '#E6E8EE',
    'editorIndentGuide.background1': '#1C212C',
    'editorIndentGuide.activeBackground1': '#2C3342',
    'editorWidget.background': '#151922',
    'editorWidget.border': '#2C3342',
    'editorSuggestWidget.background': '#151922',
    'editorSuggestWidget.border': '#2C3342',
    'editorSuggestWidget.selectedBackground': '#1C212C',
    'editorHoverWidget.background': '#151922',
    'editorHoverWidget.border': '#2C3342',
    'input.background': '#0A0C11',
    'input.border': '#2C3342',
    'focusBorder': '#4F7DFF',
    'scrollbarSlider.background': '#A0A7B824',
    'scrollbarSlider.hoverBackground': '#A0A7B840',
    'minimap.background': '#0F1218',
    'editorGutter.addedBackground': '#3DBE84',
    'editorGutter.modifiedBackground': '#4F7DFF',
    'editorGutter.deletedBackground': '#F0616D',
    'diffEditor.insertedTextBackground': '#3DBE8422',
    'diffEditor.removedTextBackground': '#F0616D22',
    'diffEditor.insertedLineBackground': '#3DBE8414',
    'diffEditor.removedLineBackground': '#F0616D14',
  },
})

// Proyectos TS/React: JSX y sin errores por módulos que el worker no puede resolver en la demo.
const tsDefaults = monaco.typescript.typescriptDefaults
tsDefaults.setCompilerOptions({
  target: monaco.typescript.ScriptTarget.ES2020,
  jsx: monaco.typescript.JsxEmit.ReactJSX,
  allowNonTsExtensions: true,
  moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
  esModuleInterop: true,
})
tsDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })

loader.config({ monaco })

export { monaco }

export async function colorize(code: string, lang: string): Promise<string> {
  monaco.editor.setTheme(THEME)
  return monaco.editor.colorize(code, lang, { tabSize: 2 })
}
