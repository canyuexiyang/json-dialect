/**
 * jsdom 环境补齐 CodeMirror 6 所需的 DOM 测量 API。
 *
 * jsdom 不实现 Range.getClientRects / getBoundingClientRect，
 * CM6 在 requestAnimationFrame 里做文本测量时会抛
 * 「textRange(...).getClientRects is not a function」。
 * 这不是被测代码的问题，而是测试环境缺口，故在此补齐。
 */

export function installCm6JsdomShims(): void {
  if (typeof Range === 'undefined') return;

  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = function getClientRects(): DOMRectList {
      const list: DOMRect[] = [];
      return {
        length: list.length,
        item: (i: number) => list[i] ?? null,
        [Symbol.iterator]: function* () {
          yield* list;
        },
      } as unknown as DOMRectList;
    };
  }

  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    };
  }
}

installCm6JsdomShims();
