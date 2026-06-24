// pptx-preview(순수 프론트엔드 pptx 미리보기)는 타입 선언을 동봉하지 않아 보강.
// API: init(el, {width,height}) → { preview(arrayBuffer) }.
declare module 'pptx-preview' {
  export interface PptxPreviewer {
    preview(data: ArrayBuffer): void;
  }
  export function init(
    el: HTMLElement,
    options?: { width?: number; height?: number },
  ): PptxPreviewer;
}
