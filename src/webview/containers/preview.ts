import CryptoJS, { SHA256 } from 'crypto-js';
import $ from 'jquery';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useContextMenu } from 'react-contexify';
import { createContainer } from 'unstated-next';
import { Backlink, WebviewConfig } from '../../notebook';
import { isBackgroundColorLight } from '../lib/utility';

window['jQuery'] = $;
window['$'] = $;

function getWindowScrollTop() {
  return document.documentElement.scrollTop || 0;
}

function setWindowScrollTop(scrollTop: number) {
  document.documentElement.scrollTop = scrollTop;
}

function getWindowHeight() {
  return window.innerHeight;
}

interface SlideData {
  line: number;
  h: number;
  v: number;
  offset: number;
}

const PreviewContainer = createContainer(() => {
  /**
   * Source URI of the current note
   */
  const sourceUri = useRef<string | undefined>(undefined);
  /**
   * Source scheme
   */
  const sourceScheme = useRef<string>('file');
  /**
   * TextEditor cursor current line position
   */
  const cursorLine = useRef<number>(-1);
  /**
   * TextEditor initial line position
   */
  const initialLine = useRef<number>(0);

  /**
   * TextEditor total buffer line count
   */
  const totalLineCount = useRef<number>(0);
  /**
   * Used to delay preview scroll
   */
  const previewScrollDelay = useRef<number>(0);
  const scrollMap = useRef<number[] | null>(null);
  const wavedromCache = useRef<Record<string, string>>({});
  // eslint-disable-next-line no-undef
  const scrollTimeout = useRef<NodeJS.Timeout | null>(null);
  // eslint-disable-next-line no-undef
  // const refreshingTimeout = useRef<NodeJS.Timeout | null>(null);
  // eslint-disable-next-line no-undef
  const isLoadingPreviewRef = useRef<boolean>(true);
  /**
   * Track the slide line number, and (h, v) indices
   */
  const slidesData = useRef<SlideData[]>([]);
  /**
   * Current slide offset
   */
  const currentSlideOffset = useRef<number>(-1);
  const previewElement = useRef<HTMLDivElement>(null);
  const hiddenPreviewElement = useRef<HTMLDivElement>(null);
  const sidebarTocElement = useRef<HTMLDivElement>(null);
  const backlinksElement = useRef<HTMLDivElement>(null);
  const backlinksSha = useRef<string>(SHA256(JSON.stringify([])).toString());
  const [showImageHelper, setShowImageHelper] = useState<boolean>(false);
  const [showSidebarToc, setShowSidebarToc] = useState<boolean>(false);
  const [sidebarTocHtml, setSidebarTocHtml] = useState<string>('');
  const [showBacklinks, setShowBacklinks] = useState<boolean>(false);
  const [isRefreshingPreview, setIsRefreshingPreview] = useState<boolean>(
    false,
  );
  const [isLoadingPreview, setIsLoadingPreview] = useState<boolean>(true);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [isMouseOverPreview, setIsMouseOverPreview] = useState<boolean>(false);
  const [renderedHtml, setRenderedHtml] = useState<string>('');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const isMobile = useMemo(() => {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    );
  }, []);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [isLoadingBacklinks, setIsLoadingBacklinks] = useState<boolean>(false);

  const isPresentationMode = useMemo(() => {
    return document.body.hasAttribute('data-presentation-mode');
  }, []);
  const isVSCodeWebExtension = useMemo(() => {
    return document.body.classList.contains('vscode-web-extension');
  }, []);
  const vscodeApi = useMemo(() => {
    if (globalThis.acquireVsCodeApi) {
      return globalThis.acquireVsCodeApi();
    }
    return null;
  }, []);
  const config = useMemo(() => {
    return JSON.parse(
      document.getElementById('crossnote-data')?.getAttribute('data-config') ??
        '{}',
    ) as WebviewConfig;
  }, []);
  const isVSCode = useMemo(() => {
    return !!config.isVSCode;
  }, [config]);
  const contextMenuId = useMemo(() => {
    return 'crossnote-context-menu';
  }, []);
  const { show: showContextMenu } = useContextMenu({
    id: contextMenuId,
  });

  const postMessage = useCallback(
    (command: string, args: unknown[] = []) => {
      // console.log('! postMessage, ', command, args, !!vscodeApi);
      if (vscodeApi) {
        vscodeApi.postMessage({
          command,
          args,
        });
      } else {
        window.parent.postMessage(
          {
            command,
            args,
          },
          'file://',
        );
      }
    },
    [vscodeApi],
  );

  const clickSidebarTocButton = useCallback(() => {
    if (isPresentationMode) {
      return window['Reveal'].toggleOverview();
    } else {
      setShowSidebarToc(x => !x);
      scrollMap.current = null;
    }
  }, [isPresentationMode]);

  const escPressed = useCallback(
    (event?: Event) => {
      event?.preventDefault();
      event?.stopPropagation();
      if (isVSCode) {
        if (!isPresentationMode) {
          clickSidebarTocButton();
        }
      } else {
        if (showImageHelper) {
          setShowImageHelper(false);
        } else {
          clickSidebarTocButton();
        }
      }
    },
    [clickSidebarTocButton, isPresentationMode, isVSCode, showImageHelper],
  );

  const buildScrollMap = useCallback(() => {
    if (scrollMap.current) {
      return scrollMap.current;
    }
    if (!totalLineCount.current || !previewElement.current) {
      return null;
    }
    const newScrollMap: number[] = [];
    const nonEmptyList: number[] = [];

    for (let i = 0; i < totalLineCount.current; i++) {
      newScrollMap.push(-1);
    }

    nonEmptyList.push(0);
    newScrollMap[0] = 0;

    // write down the offsetTop of element that has 'data-line' property to scrollMap
    const lineElements = previewElement.current.getElementsByClassName(
      'sync-line',
    );

    for (let i = 0; i < lineElements.length; i++) {
      let el = lineElements[i] as HTMLElement;
      const dataLine = el.getAttribute('data-line');
      if (!dataLine) {
        continue;
      }

      const t = parseInt(dataLine, 10);
      if (!t) {
        continue;
      }

      // this is for ignoring footnote scroll match
      if (t < nonEmptyList[nonEmptyList.length - 1]) {
        el.removeAttribute('data-line');
      } else {
        nonEmptyList.push(t);

        let offsetTop = 0;
        while (el && el !== previewElement.current) {
          offsetTop += el.offsetTop;
          el = el.offsetParent as HTMLElement;
        }

        newScrollMap[t] = Math.round(offsetTop);
      }
    }

    nonEmptyList.push(totalLineCount.current);
    newScrollMap.push(previewElement.current.scrollHeight);

    let pos = 0;
    for (let i = 0; i < totalLineCount.current; i++) {
      if (newScrollMap[i] !== -1) {
        pos++;
        continue;
      }

      const a = nonEmptyList[pos - 1];
      const b = nonEmptyList[pos];
      newScrollMap[i] = Math.round(
        (newScrollMap[b] * (i - a) + newScrollMap[a] * (b - i)) / (b - a),
      );
    }

    scrollMap.current = newScrollMap;
    return newScrollMap; // scrollMap's length == screenLineCount (vscode can't get screenLineCount... sad)
  }, []);

  const previewSyncSource = useCallback(() => {
    let scrollToLine: number;

    if (!previewElement.current) {
      return;
    }

    if (getWindowScrollTop() === 0) {
      // editorScrollDelay = Date.now() + 100
      scrollToLine = 0;

      return postMessage('revealLine', [sourceUri.current, scrollToLine]);
    }

    const top = getWindowScrollTop() + getWindowHeight() / 2;

    // try to find corresponding screen buffer row
    const scrollMap = buildScrollMap();
    if (!scrollMap) {
      return;
    }

    let i = 0;
    let j = scrollMap.length - 1;
    let count = 0;
    let screenRow = -1; // the screenRow is the bufferRow in vscode.
    let mid;

    while (count < 20) {
      if (Math.abs(top - scrollMap[i]) < 20) {
        screenRow = i;
        break;
      } else if (Math.abs(top - scrollMap[j]) < 20) {
        screenRow = j;
        break;
      } else {
        mid = Math.floor((i + j) / 2);
        if (top > scrollMap[mid]) {
          i = mid;
        } else {
          j = mid;
        }
      }
      count++;
    }

    if (screenRow === -1) {
      screenRow = mid;
    }

    scrollToLine = screenRow;

    postMessage('revealLine', [sourceUri.current, scrollToLine]);

    // @scrollToPosition(screenRow * @editor.getLineHeightInPixels() - @previewElement.offsetHeight / 2, @editor.getElement())
    // # @editor.getElement().setScrollTop
    // track currnet time to disable onDidChangeScrollTop
    // editorScrollDelay = Date.now() + 100
  }, [buildScrollMap, postMessage]);

  const scrollPreview = useCallback(() => {
    if (!config.scrollSync) {
      return;
    }

    buildScrollMap();

    if (Date.now() < previewScrollDelay.current) {
      return;
    }
    previewSyncSource();
  }, [buildScrollMap, config.scrollSync, previewSyncSource]);

  const zoomIn = useCallback(() => {
    setZoomLevel(x => x + 0.1);
  }, []);

  const zoomOut = useCallback(() => {
    setZoomLevel(x => x - 0.1);
  }, []);

  const resetZoom = useCallback(() => {
    setZoomLevel(1);
  }, []);

  const renderMathJax = useCallback(() => {
    return new Promise<void>(resolve => {
      if (!hiddenPreviewElement.current) {
        return resolve();
      }
      if (config.mathRenderingOption === 'MathJax' || config.usePandocParser) {
        // .mathjax-exps, .math.inline, .math.display
        const unprocessedElements = hiddenPreviewElement.current.querySelectorAll(
          '.mathjax-exps, .math.inline, .math.display',
        );
        if (!unprocessedElements.length) {
          return resolve();
        }

        window['MathJax'].typesetClear(); // Don't pass element here!!!
        window['MathJax'].startup.document.state(0);
        window['MathJax'].texReset();
        window['MathJax'].typesetPromise([hiddenPreviewElement]).then(() => {
          // sometimes the this callback will be called twice
          // and only the second time will the Math expressions be rendered.
          // therefore, I added the line below to check whether math is already rendered.
          if (
            !hiddenPreviewElement.current?.getElementsByClassName('MathJax')
              .length
          ) {
            return resolve();
          }

          scrollMap.current = null;
          return resolve();
        });
      } else {
        return resolve();
      }
    });
  }, [config]);

  const renderWavedrom = useCallback(() => {
    if (!hiddenPreviewElement.current) {
      return;
    }
    const els = hiddenPreviewElement.current.getElementsByClassName('wavedrom');
    if (els.length) {
      const newWavedromCache = {};
      for (let i = 0; i < els.length; i++) {
        const el = els[i] as HTMLElement;
        el.id = 'wavedrom' + i;
        const text = (el.textContent ?? '').trim();
        if (!text.length) {
          continue;
        }

        if (text in wavedromCache.current) {
          // load cache
          const svg = wavedromCache.current[text];
          el.innerHTML = svg;
          newWavedromCache[text] = svg;
          continue;
        }

        try {
          const content = window.eval(`(${text})`);
          window['WaveDrom'].RenderWaveForm(i, content, 'wavedrom');
          newWavedromCache[text] = el.innerHTML;
        } catch (error) {
          el.innerText = 'Failed to eval WaveDrom code. ' + error;
        }
      }

      wavedromCache.current = newWavedromCache;
    }
  }, []);

  const renderInteractiveVega = useCallback(() => {
    return new Promise<void>(resolve => {
      if (!previewElement.current) {
        return resolve();
      }

      const vegaElements = previewElement.current.querySelectorAll(
        '.vega, .vega-lite',
      );
      function reportVegaError(el, error) {
        el.innerHTML =
          '<pre class="language-text">' + error.toString() + '</pre>';
      }
      for (let i = 0; i < vegaElements.length; i++) {
        const vegaElement = vegaElements[i];
        try {
          const spec = JSON.parse((vegaElement.textContent ?? '').trim());
          window['vegaEmbed'](vegaElement, spec, { actions: false }).catch(
            error => {
              reportVegaError(vegaElement, error);
            },
          );
        } catch (error) {
          reportVegaError(vegaElement, error);
        }
      }
      resolve();
    });
  }, []);

  const renderMermaid = useCallback(async () => {
    if (!previewElement.current) {
      return;
    }
    const mermaid = window['mermaid']; // window.mermaid doesn't work, has to be written as window['mermaid']
    const mermaidGraphs = previewElement.current.getElementsByClassName(
      'mermaid',
    );

    const validMermaidGraphs: HTMLElement[] = [];
    for (let i = 0; i < mermaidGraphs.length; i++) {
      const mermaidGraph = mermaidGraphs[i] as HTMLElement;
      try {
        await mermaid.parse((mermaidGraph.textContent ?? '').trim());
        validMermaidGraphs.push(mermaidGraph);
      } catch (error) {
        mermaidGraph.innerHTML = `<pre class="language-text">${error.toString()}</pre>`;
      }
    }

    if (!validMermaidGraphs.length) {
      return;
    } else {
      validMermaidGraphs.forEach(async (mermaidGraph, offset) => {
        const svgId = 'svg-mermaid-' + Date.now() + '-' + offset;
        const code = (mermaidGraph.textContent ?? '').trim();
        try {
          const { svg } = await mermaid.render(svgId, code);
          mermaidGraph.innerHTML = svg;
        } catch (error) {
          const noiseElement = document.getElementById('d' + svgId);
          if (noiseElement) {
            noiseElement.style.display = 'none';
          }
          mermaidGraph.innerHTML = `<pre class="language-text">${error.toString()}</pre>`;
        }
      });
      return;
    }
  }, []);

  const runCodeChunk = useCallback(
    (id: string | null) => {
      if (!config.enableScriptExecution || !id) {
        return;
      }

      const codeChunk = document.querySelector(`.code-chunk[data-id="${id}"]`);
      if (!codeChunk) {
        return;
      }
      const running = codeChunk.classList.contains('running');
      if (running) {
        return;
      }
      codeChunk.classList.add('running');

      if (codeChunk.getAttribute('data-cmd') === 'javascript') {
        // javascript code chunk
        const code = codeChunk.getAttribute('data-code');
        try {
          window.eval(`((function(){${code}$})())`);
          codeChunk.classList.remove('running'); // done running javascript code

          const result = CryptoJS.AES.encrypt(
            codeChunk.getElementsByClassName('output-div')[0].outerHTML,
            'crossnote',
          ).toString();

          postMessage('cacheCodeChunkResult', [sourceUri.current, id, result]);
        } catch (e) {
          const outputDiv = codeChunk.getElementsByClassName('output-div')[0];
          outputDiv.innerHTML = `<pre>${e.toString()}</pre>`;
        }
      } else {
        postMessage('runCodeChunk', [sourceUri.current, id]);
      }
    },
    [config.enableScriptExecution, postMessage],
  );

  const runAllCodeChunks = useCallback(() => {
    if (!config.enableScriptExecution || !previewElement.current) {
      return;
    }

    const codeChunks = previewElement.current.getElementsByClassName(
      'code-chunk',
    );
    for (let i = 0; i < codeChunks.length; i++) {
      codeChunks[i].classList.add('running');
    }

    postMessage('runAllCodeChunks', [sourceUri.current]);
  }, [config.enableScriptExecution, postMessage]);

  const runNearestCodeChunk = useCallback(() => {
    if (!previewElement.current) {
      return;
    }
    const elements = previewElement.current.children;
    for (let i = elements.length - 1; i >= 0; i--) {
      if (
        elements[i].classList.contains('sync-line') &&
        elements[i + 1] &&
        elements[i + 1].classList.contains('code-chunk')
      ) {
        if (
          cursorLine.current >=
          parseInt(elements[i].getAttribute('data-line') ?? '0', 10)
        ) {
          const codeChunkId = elements[i + 1].getAttribute('data-id');
          if (codeChunkId) {
            return runCodeChunk(codeChunkId);
          }
        }
      }
    }
  }, [runCodeChunk]);

  const setupCodeChunks = useCallback(() => {
    if (!previewElement.current) {
      return;
    }
    const codeChunks = previewElement.current.getElementsByClassName(
      'code-chunk',
    );
    if (!codeChunks.length) {
      return;
    }

    for (let i = 0; i < codeChunks.length; i++) {
      const codeChunk = codeChunks[i];
      const id = codeChunk.getAttribute('data-id');

      // bind click event
      const runBtn = codeChunk.getElementsByClassName('run-btn')[0];
      const runAllBtn = codeChunk.getElementsByClassName('run-all-btn')[0];
      if (runBtn) {
        runBtn.addEventListener('click', () => {
          runCodeChunk(id);
        });
      }
      if (runAllBtn) {
        runAllBtn.addEventListener('click', () => {
          runAllCodeChunks();
        });
      }
    }
  }, [runAllCodeChunks, runCodeChunk]);

  const initEvents = useCallback(async () => {
    if (!previewElement.current || !hiddenPreviewElement.current) {
      return;
    }
    try {
      setIsRefreshingPreview(true);
      await Promise.all([renderMathJax(), renderWavedrom()]);

      previewElement.current.innerHTML = hiddenPreviewElement.current.innerHTML;
      hiddenPreviewElement.current.innerHTML = '';
      setRenderedHtml(previewElement.current.innerHTML);

      await Promise.all([renderInteractiveVega(), renderMermaid()]);

      setupCodeChunks();

      setIsRefreshingPreview(false);
    } catch (error) {
      console.error(error);
      setIsRefreshingPreview(false);
    }
  }, [
    renderInteractiveVega,
    renderMathJax,
    renderMermaid,
    renderWavedrom,
    setupCodeChunks,
  ]);

  const scrollSyncToSlide = useCallback((line: number) => {
    for (let i = slidesData.current.length - 1; i >= 0; i--) {
      if (line >= slidesData.current[i].line) {
        const { h, v, offset } = slidesData.current[i];
        if (offset === currentSlideOffset.current) {
          return;
        }

        currentSlideOffset.current = offset;
        previewScrollDelay.current = Date.now() + 200;
        window['Reveal'].slide(h, v);
        break;
      }
    }
  }, []);

  const scrollToPosition = useCallback((scrollTop: number) => {
    if (!previewElement.current) {
      return;
    }

    const delay = 10;
    const helper = (duration = 0) => {
      if (scrollTimeout.current) {
        clearTimeout(scrollTimeout.current);
      }

      scrollTimeout.current = setTimeout(() => {
        if (!previewElement.current) {
          return;
        }

        if (duration <= 0) {
          previewScrollDelay.current = Date.now() + 500;
          setWindowScrollTop(scrollTop);
          return;
        }

        const difference = scrollTop - getWindowScrollTop();

        const perTick = (difference / duration) * delay;

        // disable preview onscroll
        previewScrollDelay.current = Date.now() + 500;

        setWindowScrollTop(getWindowScrollTop() + perTick);
        if (getWindowScrollTop() === scrollTop) {
          return;
        }

        helper(duration - delay);
      }, delay);
    };

    const scrollDuration = 120;
    helper(scrollDuration);
  }, []);

  const scrollSyncToLine = useCallback(
    (line: number, topRatio: number = 0.372) => {
      if (!previewElement.current) {
        return;
      }
      const scrollMap = buildScrollMap();
      if (!scrollMap || line >= scrollMap.length) {
        return;
      }

      if (line + 1 === totalLineCount.current) {
        // last line
        scrollToPosition(previewElement.current.scrollHeight);
      } else {
        /**
         * Since I am not able to access the viewport of the editor
         * I used `golden section` (0.372) here for scrollTop.
         */
        scrollToPosition(
          Math.max(scrollMap[line] - getWindowHeight() * topRatio, 0),
        );
      }
    },
    [buildScrollMap, scrollToPosition],
  );

  const scrollToRevealSourceLine = useCallback(
    (line: number, topRatio = 0.372) => {
      if (line === cursorLine.current) {
        return;
      } else {
        cursorLine.current = line;
      }

      // disable preview onscroll
      previewScrollDelay.current = Date.now() + 500;

      if (isPresentationMode) {
        scrollSyncToSlide(line);
      } else {
        scrollSyncToLine(line, topRatio);
      }
    },
    [isPresentationMode, scrollSyncToLine, scrollSyncToSlide],
  );

  const bindAnchorElementsClickEvent = useCallback(() => {
    if (!previewElement.current) {
      return;
    }
    const helper = (as: HTMLAnchorElement[]) => {
      if (!previewElement.current) {
        return;
      }

      for (let i = 0; i < as.length; i++) {
        const a = as[i];
        const hrefAttr = a.getAttribute('href');
        if (!hrefAttr) {
          continue;
        }
        const href = decodeURIComponent(hrefAttr); // decodeURI here for Chinese like unicode heading
        if (href && href[0] === '#') {
          const targetElement = previewElement.current.querySelector(
            `[id="${encodeURIComponent(href.slice(1))}"]`,
          ) as HTMLElement; // fix number id bug
          if (targetElement) {
            a.onclick = event => {
              if (!previewElement.current) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();

              // jump to tag position
              let offsetTop = 0;
              let el = targetElement;
              while (el && el !== previewElement.current) {
                offsetTop += el.offsetTop;
                el = el.offsetParent as HTMLElement;
              }

              if (getWindowScrollTop() > offsetTop) {
                setWindowScrollTop(offsetTop - 32 - targetElement.offsetHeight);
              } else {
                setWindowScrollTop(offsetTop);
              }
            };
          } else {
            // without the `else` here, mpe package on Atom will fail to render preview (issue #824 and #827).
            a.onclick = event => {
              event.preventDefault();
              event.stopPropagation();
            };
          }
        } /*else if (
          // External links, like https://google.com
          isVSCodeWebExtension &&
          href.startsWith('https://') &&
          !href.startsWith('https://file+.vscode-resource.vscode-cdn.net')
        ) {
          continue;
        } */ else {
          a.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            postMessage('clickTagA', [
              {
                uri: sourceUri.current,
                href: encodeURIComponent(href.replace(/\\/g, '/')),
                scheme: sourceScheme.current,
              },
            ]);
          };
        }
      }
    };

    helper(Array.from(previewElement.current.getElementsByTagName('a')));

    if (sidebarTocElement.current) {
      helper(Array.from(sidebarTocElement.current.getElementsByTagName('a')));
    }

    if (backlinksElement.current) {
      helper(Array.from(backlinksElement.current.getElementsByTagName('a')));
    }
  }, [postMessage]);

  const bindTaskListEvent = useCallback(() => {
    if (!previewElement.current) {
      return;
    }
    const taskListItemCheckboxes = previewElement.current.getElementsByClassName(
      'task-list-item-checkbox',
    );
    for (let i = 0; i < taskListItemCheckboxes.length; i++) {
      const checkbox = taskListItemCheckboxes[i] as HTMLInputElement;
      let li = checkbox.parentElement;
      if (li && li.tagName !== 'LI') {
        li = li.parentElement;
      }
      if (li?.tagName === 'LI') {
        li.classList.add('task-list-item');

        // bind checkbox click event
        checkbox.onclick = event => {
          event.preventDefault();

          const checked = checkbox.checked;
          if (checked) {
            checkbox.setAttribute('checked', '');
          } else {
            checkbox.removeAttribute('checked');
          }

          const dataLine = parseInt(
            checkbox.getAttribute('data-line') ?? '0',
            10,
          );
          if (!isNaN(dataLine)) {
            postMessage('clickTaskListCheckbox', [sourceUri.current, dataLine]);
          }
        };
      }
    }
  }, [postMessage]);

  const updateHtml = useCallback(
    (html: string, id: string, classes: string) => {
      if (!previewElement.current || !hiddenPreviewElement.current) {
        return;
      }
      // If it's now isPresentationMode, then this function shouldn't be called.
      // If this function is called, then it might be in the case that
      //   1. Using singlePreview
      //   2. Switch from a isPresentationMode file to not isPresentationMode file.
      if (isPresentationMode) {
        return postMessage('refreshPreview', [sourceUri.current]);
      } else {
        previewScrollDelay.current = Date.now() + 500;
        hiddenPreviewElement.current.innerHTML = html;
        const scrollTop = getWindowScrollTop();
        // init several events
        initEvents().then(() => {
          if (!previewElement.current) {
            return;
          }

          scrollMap.current = null;

          bindAnchorElementsClickEvent();
          bindTaskListEvent();

          // set id and classes
          previewElement.current.id = id || '';
          previewElement.current.setAttribute(
            'class',
            `crossnote markdown-preview ${classes}`,
          );

          // scroll to initial position
          if (isLoadingPreviewRef.current) {
            isLoadingPreviewRef.current = false;
            setIsLoadingPreview(false);
            scrollToRevealSourceLine(initialLine.current);

            // clear @scrollMap after 2 seconds because sometimes
            // loading images will change scrollHeight.
            setTimeout(() => {
              scrollMap.current = null;
            }, 2000);
          } else {
            // restore scrollTop
            setWindowScrollTop(scrollTop); // <= This line is necessary...
          }
        });
      }
    },
    [
      bindAnchorElementsClickEvent,
      bindTaskListEvent,
      initEvents,
      isPresentationMode,
      postMessage,
      scrollToRevealSourceLine,
    ],
  );

  const refreshBacklinks = useCallback(
    (forceRefreshingNotes = false) => {
      if (showBacklinks && !isPresentationMode) {
        postMessage('showBacklinks', [
          {
            uri: sourceUri.current,
            forceRefreshingNotes,
            backlinksSha: backlinksSha.current,
          },
        ]);
        setIsLoadingBacklinks(true);
        if (backlinksElement.current && !config.alwaysShowBacklinksInPreview) {
          backlinksElement.current.scrollIntoView();
        }
      }
    },
    [
      config.alwaysShowBacklinksInPreview,
      isPresentationMode,
      postMessage,
      showBacklinks,
    ],
  );

  const initSlidesData = useCallback(() => {
    const slideElements = document.getElementsByTagName('section');
    let offset = 0;
    for (let i = 0; i < slideElements.length; i++) {
      const slide = slideElements[i];
      if (slide.hasAttribute('data-line')) {
        const line = parseInt(slide.getAttribute('data-line') ?? '0', 10);
        const h = parseInt(slide.getAttribute('data-h') ?? '0', 10);
        const v = parseInt(slide.getAttribute('data-v') ?? '0', 10);
        slidesData.current.push({ line, h, v, offset });
        offset += 1;
      }
    }
  }, []);

  const initPresentationEvent = useCallback(async () => {
    if (window['initRevealPresentation']) {
      // This is defined in `markdown-engine/index.ts`
      await window['initRevealPresentation']();
    }
    const firstSlide = window['Reveal'].getCurrentSlide();
    firstSlide.style.visibility = 'hidden';
    // analyze slides
    initSlidesData();

    // scroll slides
    window['Reveal'].addEventListener('slidetransitionend', () => {
      window['Reveal'].layout();
    });

    window['Reveal'].addEventListener('slidechanged', event => {
      if (Date.now() < previewScrollDelay.current) {
        return;
      }

      const { indexh, indexv } = event;
      for (const slideData of slidesData.current) {
        const { h, v, line } = slideData;
        if (h === indexh && v === indexv) {
          postMessage('revealLine', [sourceUri.current, line + 6]);
        }
      }
    });

    // slide to initial position
    window['Reveal'].configure({ transition: 'none' });
    scrollToRevealSourceLine(initialLine.current);
    window['Reveal'].configure({ transition: 'slide' });
    window['Reveal'].layout();

    if (firstSlide) {
      firstSlide.style.visibility = 'visible';
    }
    setIsLoadingPreview(false);

    // several events...
    setupCodeChunks();
    bindAnchorElementsClickEvent();
    bindTaskListEvent();
  }, [
    bindAnchorElementsClickEvent,
    bindTaskListEvent,
    initSlidesData,
    postMessage,
    scrollToRevealSourceLine,
    setupCodeChunks,
  ]);

  const onMessageEventHandler = useCallback(
    (event: MessageEvent) => {
      // console.log('! receiveMessage: ', event.data);
      const data = event.data;
      if (!data || !previewElement.current) {
        // console.log('! failed! ', !!data, !!previewElement.current);
        return;
      }

      if (data.command === 'updateHtml') {
        const {
          totalLineCount: total,
          tocHTML,
          sourceUri: uri,
          sourceScheme: scheme,
        } = data;
        totalLineCount.current = total;
        setSidebarTocHtml(tocHTML);
        sourceUri.current = uri;
        sourceScheme.current = scheme;
        updateHtml(data.html, data.id, data.class);
      } else if (
        data.command === 'changeTextEditorSelection' &&
        (config.scrollSync || data.forced)
      ) {
        const line = parseInt(data.line, 10);
        let topRatio = parseFloat(data.topRatio);
        if (isNaN(topRatio)) {
          topRatio = 0.372;
        }
        scrollToRevealSourceLine(line, topRatio);
      } else if (data.command === 'startParsingMarkdown') {
        /**
         * show refreshingIcon after 1 second
         * if preview hasn't finished rendering.
         */
        /*
      if (refreshingTimeout.current) {
        clearTimeout(refreshingTimeout.current);
      }

      refreshingTimeout.current = setTimeout(() => {
        setIsRefreshingPreview(true);
      }, 1000);
      */
      } else if (data.command === 'openImageHelper') {
        // TODO: Replace this with headless modal
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setShowImageHelper(true);
      } else if (data.command === 'runAllCodeChunks') {
        runAllCodeChunks();
      } else if (data.command === 'runCodeChunk') {
        runNearestCodeChunk();
      } else if (data.command === 'escPressed') {
        // this.escPressed();
      } else if (data.command === 'previewSyncSource') {
        previewSyncSource();
      } else if (data.command === 'copy') {
        document.execCommand('copy');
      } else if (data.command === 'zommIn') {
        zoomIn();
      } else if (data.command === 'zoomOut') {
        zoomOut();
      } else if (data.command === 'resetZoom') {
        resetZoom();
      } else if (data.command === 'scrollPreviewToTop') {
        if (isPresentationMode) {
          window['Reveal'].slide(0);
        } else {
          setWindowScrollTop(0);
        }
      } else if (data.command === 'backlinks') {
        const { backlinks, hasUpdate, sourceUri: uri } = data;
        if (sourceUri.current === uri && hasUpdate) {
          setBacklinks(backlinks);
        }
        setIsLoadingBacklinks(false);
      } else if (data.command === 'updatedNote') {
        refreshBacklinks();
      } else if (data.command === 'createdNote') {
        refreshBacklinks();
      } else if (data.command === 'deletedNote') {
        refreshBacklinks();
      }
    },
    [
      config.scrollSync,
      isPresentationMode,
      previewSyncSource,
      refreshBacklinks,
      resetZoom,
      runAllCodeChunks,
      runNearestCodeChunk,
      scrollToRevealSourceLine,
      updateHtml,
      zoomIn,
      zoomOut,
    ],
  );

  const onKeydownEventHandler = useCallback(
    (event: KeyboardEvent) => {
      if (!previewElement.current) {
        return;
      }

      if (event.shiftKey && event.ctrlKey && event.which === 83) {
        // ctrl+shift+s preview sync source
        return previewSyncSource();
      } else if (event.metaKey || event.ctrlKey) {
        // ctrl+c copy
        if (event.which === 67) {
          // [c] copy
          document.execCommand('copy');
        } else if (event.which === 187 && !isVSCode) {
          // [+] zoom in
          zoomIn();
        } else if (event.which === 189 && !isVSCode) {
          // [-] zoom out
          zoomOut();
        } else if (event.which === 48 && !isVSCode) {
          // [0] reset zoom
          resetZoom();
        } else if (event.which === 38) {
          // [ArrowUp] scroll to the most top
          if (isPresentationMode) {
            window['Reveal'].slide(0);
          } else {
            setWindowScrollTop(0);
          }
        }
      } else if (event.which === 27) {
        // [esc] toggle sidebar toc
        escPressed(event);
      }
    },
    [
      escPressed,
      isPresentationMode,
      isVSCode,
      previewSyncSource,
      resetZoom,
      zoomIn,
      zoomOut,
    ],
  );

  const onResizeEventHandler = useCallback(() => {
    scrollMap.current = null;
  }, []);

  useEffect(() => {
    sourceUri.current = config.sourceUri;
    cursorLine.current = config.cursorLine ?? -1;
    initialLine.current = config.initialLine ?? 0;
    setZoomLevel(config.zoomLevel ?? 1);
  }, [config]);

  /**
   * Sidebar ToC HTML
   */
  useEffect(() => {
    if (showSidebarToc) {
      document.body.classList.add('show-sidebar-toc');
      if (sidebarTocElement.current) {
        if (sidebarTocHtml.length > 0) {
          sidebarTocElement.current.innerHTML = sidebarTocHtml;
          bindAnchorElementsClickEvent();
        } else {
          sidebarTocElement.current.innerHTML = `<p style="text-align:center;font-style: italic;">Outline (empty)</p>`;
        }
      }
    } else {
      document.body.classList.remove('show-sidebar-toc');
    }
  }, [showSidebarToc, sidebarTocHtml, bindAnchorElementsClickEvent]);

  useEffect(() => {
    // TODO: Support pagination in the future
    refreshBacklinks();
  }, [refreshBacklinks]);

  useEffect(() => {
    backlinksSha.current = SHA256(JSON.stringify(backlinks)).toString();
  }, [backlinks]);

  useEffect(() => {
    setShowBacklinks(!!config.alwaysShowBacklinksInPreview);
  }, [config.alwaysShowBacklinksInPreview]);

  /**
   * Keyboard events
   */
  useEffect(() => {
    document.addEventListener('keydown', onKeydownEventHandler);
    return () => {
      document.removeEventListener('keydown', onKeydownEventHandler);
    };
  }, [onKeydownEventHandler]);

  /**
   * Window resize event
   */
  useEffect(() => {
    window.addEventListener('resize', onResizeEventHandler);
    return () => {
      window.removeEventListener('resize', onResizeEventHandler);
    };
  }, [onResizeEventHandler]);

  /**
   * Message
   */
  useEffect(() => {
    window.addEventListener('message', onMessageEventHandler);
    return () => {
      window.removeEventListener('message', onMessageEventHandler);
    };
  }, [onMessageEventHandler]);

  /**
   * Scroll
   */
  useEffect(() => {
    const element = previewElement.current;
    if (!isPresentationMode && element) {
      window.addEventListener('scroll', scrollPreview);
    }
    return () => {
      if (!isPresentationMode && element) {
        window.removeEventListener('scroll', scrollPreview);
      }
    };
  }, [isPresentationMode, scrollPreview]);

  useEffect(() => {
    if (!isVSCode) {
      postMessage('setZoomLevel', [sourceUri.current, zoomLevel]);
    }
  }, [isVSCode, postMessage, zoomLevel]);

  /**
   * On load
   */
  useEffect(() => {
    if (
      !previewElement.current ||
      !hiddenPreviewElement.current ||
      !sourceUri.current
    ) {
      return;
    }
    if (document.body.hasAttribute('data-html')) {
      previewElement.current.innerHTML =
        document.body.getAttribute('data-html') ?? '';
      document.body.removeAttribute('data-html');
      setRenderedHtml(previewElement.current.innerHTML);
    }

    if (!isPresentationMode) {
      const isDarkColorScheme = window.matchMedia(
        '(prefers-color-scheme: dark)',
      ).matches;

      postMessage('webviewFinishLoading', [
        {
          uri: sourceUri.current,
          systemColorScheme: isDarkColorScheme ? 'dark' : 'light',
        },
      ]);
    } else {
      config.scrollSync = true; // <= force to enable scrollSync for presentation
      initPresentationEvent();
    }

    // make it possible for interactive vega to load local data files
    const base = document.createElement('base');
    if (sourceUri.current) {
      base.href = sourceUri.current;
    }
    document.head.appendChild(base);
  }, [config, initPresentationEvent, isPresentationMode, postMessage]);

  useEffect(() => {
    if (previewElement.current) {
      const isLightTheme = isBackgroundColorLight(document.body);
      setTheme(isLightTheme ? 'light' : 'dark');
    }
  }, [
    config.previewTheme,
    config.revealjsTheme,
    config.codeBlockTheme,
    config.globalCss,
    renderedHtml,
  ]);

  return {
    backlinks,
    backlinksElement,
    bindAnchorElementsClickEvent,
    clickSidebarTocButton,
    config,
    contextMenuId,
    hiddenPreviewElement,
    isLoadingBacklinks,
    isLoadingPreview,
    isMobile,
    isMouseOverPreview,
    isPresentationMode,
    isRefreshingPreview,
    isVSCode,
    isVSCodeWebExtension,
    postMessage,
    previewElement,
    previewSyncSource,
    refreshBacklinks,
    setIsMouseOverPreview,
    setShowBacklinks,
    setShowImageHelper,
    showBacklinks,
    showContextMenu,
    showImageHelper,
    showSidebarToc,
    sidebarTocElement,
    sidebarTocHtml,
    sourceScheme,
    sourceUri,
    theme,
    zoomLevel,
  };
});

export default PreviewContainer;
