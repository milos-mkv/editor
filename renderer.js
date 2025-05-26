// Use window.require for Node.js modules in renderer process

console.log('Monaco editor loaded');

const remote = require('@electron/remote');
const { dialog } = remote;
const fs = require('fs');
const path = require('path');
// ✅ Proceed with your code safely here (loadDirectory, openFile, etc.)
// Example:
console.log('Remote dialog:', dialog);
// ... your logic below ...

let isUpdating = false;
let editor; // CodeMirror instance
let expandedPaths = new Set(); // Keep track of expanded folders
let openFiles = new Map(); // Map of open files: path -> { editor, content }
let activeFile = null; // Currently active file path
let breakpoints = new Set();
let debugState = null;
let currentDebugLine = null;

// Function to get cursor position
function getCaretPosition(element) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return 0;
    
    const range = selection.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(element);
    preCaretRange.setEnd(range.endContainer, range.endOffset);
    return preCaretRange.toString().length;
}

// Function to set cursor position
function setCaretPosition(element, position) {
    const selection = window.getSelection();
    const range = document.createRange();
    
    let currentPos = 0;
    let targetNode = null;
    let targetOffset = 0;
    
    function traverseNodes(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            const nextPos = currentPos + node.length;
            if (currentPos <= position && position <= nextPos) {
                targetNode = node;
                targetOffset = position - currentPos;
                return true;
            }
            currentPos = nextPos;
        } else {
            for (const child of node.childNodes) {
                if (traverseNodes(child)) return true;
            }
        }
        return false;
    }
    
    traverseNodes(element);
    
    if (targetNode) {
        range.setStart(targetNode, targetOffset);
        range.setEnd(targetNode, targetOffset);
        selection.removeAllRanges();
        selection.addRange(range);
    }
}

// Function to update syntax highlighting
function updateSyntaxHighlighting() {
    const editor = document.getElementById('editor');
    const highlightLayer = document.querySelector('#highlight-layer code');
    const content = editor.value;
    
    // Update highlight layer
    highlightLayer.textContent = content;
    Prism.highlightElement(highlightLayer);
}

// Function to sync scroll positions
function syncScroll(e) {
    const editor = document.getElementById('editor');
    const highlightLayer = document.getElementById('highlight-layer');
    const lineNumbers = document.getElementById('lineNumbers');
    const lineNumbersContent = lineNumbers.querySelector('.line-numbers-content');
    
    highlightLayer.scrollTop = editor.scrollTop;
    highlightLayer.scrollLeft = editor.scrollLeft;
    lineNumbersContent.style.transform = `translateY(${-editor.scrollTop}px)`;
}

// Function to update line numbers
function updateLineNumbers() {
    const editor = document.getElementById('editor');
    const lineNumbers = document.getElementById('lineNumbers');
    const lines = editor.value.split('\n');
    
    // Create line numbers container if it doesn't exist
    let lineNumbersContent = lineNumbers.querySelector('.line-numbers-content');
    if (!lineNumbersContent) {
        lineNumbersContent = document.createElement('div');
        lineNumbersContent.className = 'line-numbers-content';
        lineNumbers.appendChild(lineNumbersContent);
    }
    
    // Create line numbers HTML
    const numbers = [];
    for (let i = 0; i < Math.max(1, lines.length); i++) {
        numbers.push(`<div class="line-number">${i + 1}</div>`);
    }
    lineNumbersContent.innerHTML = numbers.join('');
    
    // Update line numbers container position
    lineNumbersContent.style.transform = `translateY(${-editor.scrollTop}px)`;
}

// Function to handle tab key
function handleTabKey(e) {
    if (e.key === 'Tab') {
        e.preventDefault();
        const editor = document.getElementById('editor');
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        
        // Insert tab
        editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
        
        // Put cursor at right position again
        editor.selectionStart = editor.selectionEnd = start + 4;
        
        updateSyntaxHighlighting();
        updateLineNumbers();
    }
}

// Function to handle paste events
function handlePaste(e) {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    const textNode = document.createTextNode(text);
    range.deleteContents();
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    selection.removeAllRanges();
    selection.addRange(range);
    updateSyntaxHighlighting();
}

// Function to create file explorer item
function createFileItem(name, isDirectory, fullPath) {
    const item = document.createElement('div');
    item.className = 'file-item';
    if (isDirectory) {
        item.classList.add('directory');
    } else {
        item.classList.add('file');
    }

    // Create content container
    const content = document.createElement('div');
    content.className = 'content';

    // Create arrow for directories
    if (isDirectory) {
        const arrow = document.createElement('div');
        arrow.className = 'arrow';
        if (expandedPaths.has(fullPath)) {
            arrow.classList.add('expanded');
        }
        const arrowIcon = document.createElement('i');
        arrowIcon.className = 'material-icons';
        arrowIcon.textContent = 'chevron_right';
        arrow.appendChild(arrowIcon);
        content.appendChild(arrow);
    }
    
    const icon = document.createElement('span');
    icon.className = 'icon';
    const iconI = document.createElement('i');
    iconI.className = 'material-icons';
    iconI.textContent = isDirectory ? 'folder' : getFileIcon(name);
    icon.appendChild(iconI);
    
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = name;
    
    content.appendChild(icon);
    content.appendChild(text);
    item.appendChild(content);

    if (isDirectory) {
        // Create container for children
        const children = document.createElement('div');
        children.className = 'file-item-children';
        if (expandedPaths.has(fullPath)) {
            children.classList.add('expanded');
        }
        item.appendChild(children);

        // Click handler for the directory
        content.addEventListener('click', (e) => {
            e.stopPropagation();
            const arrow = content.querySelector('.arrow');
            const isExpanded = arrow.classList.contains('expanded');
            
            if (isExpanded) {
                arrow.classList.remove('expanded');
                children.classList.remove('expanded');
                expandedPaths.delete(fullPath);
            } else {
                arrow.classList.add('expanded');
                children.classList.add('expanded');
                expandedPaths.add(fullPath);
                // Load children if not already loaded
                if (!children.children.length) {
                    loadDirectoryContents(fullPath, children);
                }
            }
        });
    } else {
        // Click handler for files
        content.addEventListener('click', (e) => {
            e.stopPropagation();
            openFile(fullPath);
        });
    }

    return item;
}

// Function to load directory contents
function loadDirectoryContents(dirPath, container) {
    try {
        const items = fs.readdirSync(dirPath);
        
        // Get stats for all items and sort them
        const sortedItems = items
            .map(item => {
                const fullPath = path.join(dirPath, item);
                try {
                    const stats = fs.statSync(fullPath);
                    return {
                        name: item,
                        fullPath,
                        isDirectory: stats.isDirectory()
                    };
                } catch (error) {
                    console.error(`Error getting stats for ${fullPath}:`, error);
                    return null;
                }
            })
            .filter(item => item !== null)
            .sort((a, b) => {
                // Directories first, then alphabetically
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return a.name.localeCompare(b.name);
            });
        
        // Create and append items to container
        sortedItems.forEach(item => {
            const fileItem = createFileItem(item.name, item.isDirectory, item.fullPath);
            container.appendChild(fileItem);
            
            // If this is node_modules and it's expanded, load its contents immediately
            if (item.name === 'node_modules' && expandedPaths.has(item.fullPath)) {
                const children = fileItem.querySelector('.file-item-children');
                loadDirectoryContents(item.fullPath, children);
            }
        });
    } catch (error) {
        console.error('Error loading directory:', error);
        container.innerHTML = `<div class="error-message">Error loading directory: ${error.message}</div>`;
    }
}

// Function to load root directory
function loadDirectory(dirPath) {
    console.log('Loading directory:', dirPath);
    const explorer = document.getElementById('file-explorer');
    explorer.innerHTML = '';
    
    try {
        // Create root item
        const rootName = path.basename(dirPath);
        const rootItem = createFileItem(rootName, true, dirPath);
        explorer.appendChild(rootItem);
        
        // Auto-expand root
        const arrow = rootItem.querySelector('.arrow');
        const children = rootItem.querySelector('.file-item-children');
        arrow.classList.add('expanded');
        children.classList.add('expanded');
        expandedPaths.add(dirPath);
        loadDirectoryContents(dirPath, children);

        // Store current directory path
        window.currentDirectory = dirPath;
        console.log('Directory loaded successfully');
    } catch (error) {
        console.error('Error loading directory:', error);
        explorer.innerHTML = `<div class="error-message">Error loading directory: ${error.message}</div>`;
    }
}

// Function to create a new tab
function createTab(filePath) {
    const fileName = path.basename(filePath);
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.path = filePath;
    
    const icon = document.createElement('span');
    icon.className = 'icon';
    const iconI = document.createElement('i');
    iconI.className = 'material-icons';
    iconI.textContent = getFileIcon(fileName);
    icon.appendChild(iconI);

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = fileName;

    const close = document.createElement('span');
    close.className = 'close';
    const closeIcon = document.createElement('i');
    closeIcon.className = 'material-icons';
    closeIcon.textContent = 'close';
    close.appendChild(closeIcon);

    tab.appendChild(icon);
    tab.appendChild(title);
    tab.appendChild(close);

    // Click handler for tab
    tab.addEventListener('click', (e) => {
        if (!e.target.closest('.close')) {
            switchToFile(filePath);
        }
    });

    // Click handler for close button
    close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeFile(filePath);
    });

    return tab;
}

// Function to switch to a file
function switchToFile(filePath) {
    // Remove active class from current tab
    const currentTab = document.querySelector('.tab.active');
    if (currentTab) {
        currentTab.classList.remove('active');
    }

    // Add active class to new tab
    const newTab = document.querySelector(`.tab[data-path="${filePath}"]`);
    if (newTab) {
        newTab.classList.add('active');
        // Ensure the tab is visible by scrolling to it
        newTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }

    // Update editor content
    const fileData = openFiles.get(filePath);
    if (fileData) {
        editor.setValue(fileData.content);
        editor.refresh();
    }

    activeFile = filePath;
}

// Function to close a file
function closeFile(filePath) {
    const tabBar = document.querySelector('.tab-bar');
    const tab = document.querySelector(`.tab[data-path="${filePath}"]`);
    
    if (tab) {
        // If closing active tab, switch to another tab
        if (activeFile === filePath) {
            const nextTab = tab.nextElementSibling || tab.previousElementSibling;
            if (nextTab) {
                switchToFile(nextTab.dataset.path);
            }
        }
        
        // Remove tab and file data
        tab.remove();
        openFiles.delete(filePath);
        
        // If no tabs left, show welcome screen
        if (openFiles.size === 0) {
            editor.setValue('-- Welcome to Lua Editor\nlocal function hello()\n    print("Hello, World!")\nend\n\nhello()');
            activeFile = null;
        }
    }
}

// Function to open a file
function openFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        
        // Create new tab if file isn't already open
        if (!openFiles.has(filePath)) {
            const tabBar = document.querySelector('.tab-bar');
            const tab = createTab(filePath);
            
            // Find the active tab and insert the new tab after it
            const activeTab = tabBar.querySelector('.tab.active');
            if (activeTab) {
                activeTab.classList.remove('active');
                activeTab.insertAdjacentElement('afterend', tab);
            } else {
                // If no active tab, insert at the beginning (before run button)
                const runButton = tabBar.querySelector('.run-button');
                tabBar.insertBefore(tab, runButton);
            }
            
            openFiles.set(filePath, {
                content: content
            });
        }
        
        // Switch to the file
        switchToFile(filePath);
        
        // Update window title
        document.title = `Lua Editor - ${path.basename(filePath)}`;
        
        console.log('File opened successfully');
    } catch (error) {
        console.error('Error opening file:', error);
        alert(`Error opening file: ${error.message}`);
    }
}

// Function to handle folder opening
async function openFolder() {
    console.log('Opening folder dialog');
    try {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: 'Select Folder to Open',
            buttonLabel: 'Open Folder'
        });

        console.log('Dialog result:', result);

        if (!result.canceled && result.filePaths.length > 0) {
            const folderPath = result.filePaths[0];
            console.log('Selected folder:', folderPath);
            loadDirectory(folderPath);
        }
    } catch (error) {
        console.error('Error in openFolder:', error);
        alert(`Error opening folder: ${error.message}`);
    }
}

// Add styles for file explorer
const style = document.createElement('style');
style.textContent = `
    .file-item {
        padding: 5px;
        cursor: pointer;
        display: flex;
        align-items: center;
        color: #ffffff;
    }
    .file-item:hover {
        background-color: #37373d;
    }
    .file-item .icon {
        margin-right: 5px;
    }
    .file-item.directory {
        color: #c5c5c5;
    }
    .file-item.file {
        color: #9cdcfe;
    }
    .error-message {
        color: #f44336;
        padding: 10px;
        margin: 10px;
        background-color: #1e1e1e;
        border: 1px solid #f44336;
        border-radius: 4px;
    }
`;
document.head.appendChild(style);

// Initialize splitter functionality
function initSplitter() {
    const splitter = document.querySelector('.splitter');
    const sidebar = document.getElementById('sidebar');
    const container = document.getElementById('container');
    let isResizing = false;

    splitter.addEventListener('mousedown', (e) => {
        isResizing = true;
        splitter.classList.add('dragging');
        document.body.classList.add('dragging');
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        // Get the container's left edge position
        const containerRect = container.getBoundingClientRect();
        // Calculate width based on mouse position relative to container
        const newWidth = Math.max(100, Math.min(
            e.clientX - containerRect.left,
            window.innerWidth * 0.8
        ));

        sidebar.style.width = `${newWidth}px`;
        
        // Ensure CodeMirror updates its layout
        if (editor) {
            editor.refresh();
        }
    });

    document.addEventListener('mouseup', () => {
        isResizing = false;
        splitter.classList.remove('dragging');
        document.body.classList.remove('dragging');
    });

    // Handle window resize
    window.addEventListener('resize', () => {
        const maxWidth = window.innerWidth * 0.8;
        if (sidebar.offsetWidth > maxWidth) {
            sidebar.style.width = `${maxWidth}px`;
            if (editor) {
                editor.refresh();
            }
        }
    });
}

// Function to create minimap
function createMinimap(editor) {
    // Create minimap container
    const minimapContainer = document.createElement('div');
    minimapContainer.className = 'minimap';
    editor.getWrapperElement().parentNode.appendChild(minimapContainer);

    // Create minimap editor instance
    const minimap = CodeMirror(minimapContainer, {
        value: editor.getValue(),
        mode: 'lua',
        theme: 'monokai',
        readOnly: true,
        lineNumbers: false,
        scrollbarStyle: null,
        lineWrapping: false,
        dragDrop: false,
        cursorBlinkRate: -1
    });

    // Create slider
    const slider = document.createElement('div');
    slider.className = 'minimap-slider';
    minimapContainer.appendChild(slider);

    // Add minimap class to main editor
    editor.getWrapperElement().classList.add('has-minimap');

    // Update minimap content and slider position
    function updateMinimap() {
        // Update content if needed
        if (minimap.getValue() !== editor.getValue()) {
            minimap.setValue(editor.getValue());
        }

        // Calculate and update slider position and height
        const editorInfo = editor.getScrollInfo();
        const totalHeight = editorInfo.height;
        const viewportHeight = editorInfo.clientHeight;
        const scrollTop = editorInfo.top;

        const sliderHeight = Math.max(
            (viewportHeight / totalHeight) * minimapContainer.clientHeight,
            30
        );
        const sliderTop = (scrollTop / totalHeight) * minimapContainer.clientHeight;

        slider.style.height = `${sliderHeight}px`;
        slider.style.top = `${sliderTop}px`;

        // Scroll minimap
        const minimapScrollTop = (scrollTop / totalHeight) * minimap.getScrollInfo().height;
        minimap.scrollTo(0, minimapScrollTop);
    }

    // Handle slider dragging
    let isDragging = false;
    let startY = 0;
    let startTop = 0;

    slider.addEventListener('mousedown', (e) => {
        isDragging = true;
        startY = e.clientY;
        startTop = parseFloat(slider.style.top || '0');
        document.body.classList.add('dragging');
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const delta = e.clientY - startY;
        const newTop = Math.max(0, Math.min(
            minimapContainer.clientHeight - slider.clientHeight,
            startTop + delta
        ));
        slider.style.top = `${newTop}px`;

        // Update editor scroll position
        const scrollRatio = newTop / (minimapContainer.clientHeight - slider.clientHeight);
        const editorInfo = editor.getScrollInfo();
        const maxScroll = editorInfo.height - editorInfo.clientHeight;
        editor.scrollTo(0, maxScroll * scrollRatio);
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        document.body.classList.remove('dragging');
    });

    // Listen for editor changes and scroll
    editor.on('change', updateMinimap);
    editor.on('scroll', updateMinimap);
    editor.on('viewportChange', updateMinimap);

    // Initial update
    updateMinimap();

    return minimap;
}

// Console functionality
function initConsole() {
    const consoleContainer = document.querySelector('.console-container');
    const consoleHeader = document.querySelector('.console-header');
    const consoleContent = document.querySelector('.console-content');
    const closeButton = consoleHeader.querySelector('.action-button');
    const editorWrapper = document.querySelector('.editor-wrapper');
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    // Create resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'console-resize-handle';
    consoleContainer.insertBefore(resizeHandle, consoleContainer.firstChild);

    // Handle resize
    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startY = e.clientY;
        startHeight = consoleContainer.offsetHeight;
        document.body.classList.add('dragging');
        resizeHandle.classList.add('dragging');
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        const editorWrapperRect = editorWrapper.getBoundingClientRect();
        const maxHeight = editorWrapperRect.height * 0.8;
        const delta = startY - e.clientY;
        const newHeight = Math.min(
            Math.max(35, startHeight + delta),
            maxHeight
        );

        consoleContainer.style.height = `${newHeight}px`;

        // Refresh editor layout if using Monaco
        if (window.editor && window.editor.layout) {
            window.editor.layout();
        }
        // Refresh CodeMirror if using it
        if (editor && editor.refresh) {
            editor.refresh();
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.classList.remove('dragging');
            resizeHandle.classList.remove('dragging');
            
            // Final refresh of editors
            if (window.editor && window.editor.layout) {
                window.editor.layout();
            }
            if (editor && editor.refresh) {
                editor.refresh();
            }
        }
    });

    // Toggle console visibility
    closeButton.addEventListener('click', () => {
        consoleContainer.style.display = 'none';
        // Refresh editor layout
        if (window.editor && window.editor.layout) {
            window.editor.layout();
        }
        if (editor && editor.refresh) {
            editor.refresh();
        }
        // Force minimap refresh
        const minimap = document.querySelector('.minimap');
        if (minimap) {
            const minimapEditor = minimap.querySelector('.CodeMirror');
            if (minimapEditor && minimapEditor.CodeMirror) {
                setTimeout(() => {
                    minimapEditor.CodeMirror.refresh();
                    // Update minimap slider height
                    const slider = document.querySelector('.minimap-slider');
                    if (slider) {
                        const editorHeight = editor.getScrollInfo().clientHeight;
                        const totalHeight = editor.getScrollInfo().height;
                        const sliderHeight = (editorHeight / totalHeight) * minimap.clientHeight;
                        slider.style.height = `${sliderHeight}px`;
                    }
                }, 0);
            }
        }
    });

    // Double click header to toggle maximize
    consoleHeader.addEventListener('dblclick', () => {
        const editorWrapperRect = editorWrapper.getBoundingClientRect();
        const maxHeight = editorWrapperRect.height * 0.8;
        
        if (consoleContainer.offsetHeight >= maxHeight * 0.9) {
            consoleContainer.style.height = '200px';
        } else {
            consoleContainer.style.height = `${maxHeight}px`;
        }
        
        // Refresh editor layout
        if (window.editor && window.editor.layout) {
            window.editor.layout();
        }
        if (editor && editor.refresh) {
            editor.refresh();
        }
    });

    // Override console.log and other console methods
    const originalConsole = {
        log: console.log,
        error: console.error,
        warn: console.warn,
        info: console.info
    };

    function createConsoleMessage(type, args) {
        const message = document.createElement('div');
        message.className = `console-message ${type}`;
        
        const icon = document.createElement('span');
        icon.className = 'icon material-icons';
        switch (type) {
            case 'error':
                icon.textContent = 'error';
                break;
            case 'warning':
                icon.textContent = 'warning';
                break;
            case 'info':
                icon.textContent = 'info';
                break;
            default:
                icon.textContent = 'chevron_right';
        }
        
        const content = document.createElement('span');
        content.className = 'content';
        content.textContent = args.map(arg => 
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
        ).join(' ');
        
        message.appendChild(icon);
        message.appendChild(content);
        consoleContent.appendChild(message);
        consoleContent.scrollTop = consoleContent.scrollHeight;
    }

    // Override console methods
    console.log = (...args) => {
        originalConsole.log.apply(console, args);
        createConsoleMessage('log', args);
    };

    console.error = (...args) => {
        originalConsole.error.apply(console, args);
        createConsoleMessage('error', args);
    };

    console.warn = (...args) => {
        originalConsole.warn.apply(console, args);
        createConsoleMessage('warning', args);
    };

    console.info = (...args) => {
        originalConsole.info.apply(console, args);
        createConsoleMessage('info', args);
    };

    // Add some initial messages
    console.info('Console initialized');
    console.log('Welcome to Lua Editor');
}

// Function to toggle breakpoint
function toggleBreakpoint(lineNumber) {
    const model = editor.getModel();
    const decorations = model.getLineDecorations(lineNumber);
    const hasBreakpoint = decorations.some(d => d.options.glyphMarginClassName === 'breakpoint');
    
    if (hasBreakpoint) {
        // Remove breakpoint
        const newDecorations = decorations
            .filter(d => d.options.glyphMarginClassName !== 'breakpoint')
            .map(d => ({
                range: d.range,
                options: d.options
            }));
        model.deltaDecorations(decorations.map(d => d.id), newDecorations);
        breakpoints.delete(lineNumber);
    } else {
        // Add breakpoint
        model.deltaDecorations([], [{
            range: new monaco.Range(lineNumber, 1, lineNumber, 1),
            options: {
                isWholeLine: true,
                glyphMarginClassName: 'breakpoint',
                glyphMarginHoverMessage: { value: 'Breakpoint' }
            }
        }]);
        breakpoints.add(lineNumber);
    }
}

// Base Lua execution function
async function runLuaCode() {
    const runButton = document.getElementById('runButton');
    runButton.classList.add('running');
    let L = null;
    let shouldContinue = false;
    
    try {
        const code = editor.getValue();
        if (!code.trim()) {
            console.log('No code to execute');
            return;
        }

        // Create new Lua state
        L = fengari.lauxlib.luaL_newstate();
        if (!L) {
            throw new Error('Failed to create Lua state');
        }

        // Open standard libraries
        fengari.lualib.luaL_openlibs(L);

        // Set up debug controls
        const debugContinue = document.getElementById('debugContinue');
        const debugStepOver = document.getElementById('debugStepOver');
        const debugStepInto = document.getElementById('debugStepInto');
        const debugStop = document.getElementById('debugStop');

        // Clear any previous handlers
        debugContinue.onclick = null;
        debugStepOver.onclick = null;
        debugStepInto.onclick = null;
        debugStop.onclick = null;

        // Set up new handlers
        debugContinue.onclick = () => {
            shouldContinue = true;
        };

        debugStepOver.onclick = () => {
            if (debugState) {
                const nextLine = debugState.line + 1;
                breakpoints.add(nextLine);
                shouldContinue = true;
                setTimeout(() => {
                    breakpoints.delete(nextLine);
                }, 0);
            }
        };

        debugStepInto.onclick = () => {
            shouldContinue = true;
        };

        debugStop.onclick = () => {
            if (L) {
                fengari.lua.lua_close(L);
                L = null;
            }
            cleanup();
        };

        // Override print function
        const luaPrint = function(L) {
            const nargs = fengari.lua.lua_gettop(L);
            const args = [];
            for (let i = 1; i <= nargs; i++) {
                if (fengari.lua.lua_isstring(L, i)) {
                    args.push(fengari.lua.lua_tojsstring(L, i));
                } else if (fengari.lua.lua_isnumber(L, i)) {
                    args.push(fengari.lua.lua_tonumber(L, i));
                } else if (fengari.lua.lua_isnil(L, i)) {
                    args.push('nil');
                } else if (fengari.lua.lua_isboolean(L, i)) {
                    args.push(fengari.lua.lua_toboolean(L, i) ? 'true' : 'false');
                } else {
                    args.push(fengari.lua.lua_typename(L, fengari.lua.lua_type(L, i)));
                }
            }
            console.log(args.join(' '));
            return 0;
        };

        fengari.lua.lua_pushjsfunction(L, luaPrint);
        fengari.lua.lua_setglobal(L, 'print');

        // Set up debug hook with optimized waiting
        fengari.lua.lua_sethook(L, (L, ar) => {
            if (!ar || typeof ar.currentline !== 'number') return;
            const currentLine = ar.currentline;
            
            if (breakpoints.has(currentLine)) {
                shouldContinue = false;
                debugState = { line: currentLine };
                
                // Update UI using requestAnimationFrame for better performance
                requestAnimationFrame(() => {
                    highlightDebugLine(currentLine);
                    updateDebugControls(true);
                });

                // Use a more efficient waiting mechanism
                const checkContinue = () => {
                    if (!shouldContinue) {
                        setTimeout(checkContinue, 50); // Reduced interval for better responsiveness
                        return;
                    }
                    
                    requestAnimationFrame(() => {
                        highlightDebugLine(null);
                        updateDebugControls(false);
                    });
                    debugState = null;
                };
                
                checkContinue();
            }
        }, fengari.lua.LUA_MASKLINE, 0);

        // Execute code in chunks to allow UI updates
        const executeChunk = async () => {
            const loadStatus = fengari.lauxlib.luaL_loadstring(L, fengari.to_luastring(code));
            if (loadStatus !== 0) {
                const error = fengari.lua.lua_tojsstring(L, -1);
                throw new Error('Lua Syntax Error: ' + error);
            }

            // Run with periodic yields to keep UI responsive
            const runStatus = fengari.lua.lua_pcall(L, 0, 0, 0);
            if (runStatus !== 0) {
                const error = fengari.lua.lua_tojsstring(L, -1);
                throw new Error('Lua Runtime Error: ' + error);
            }
        };

        // Start execution with a small delay to allow UI to update
        await new Promise(resolve => setTimeout(resolve, 0));
        await executeChunk();
        cleanup();

    } catch (error) {
        console.error('Error:', error.message);
        cleanup();
    }

    function cleanup() {
        if (L) {
            fengari.lua.lua_close(L);
            L = null;
        }
        runButton.classList.remove('running');
        updateDebugControls(false);
        highlightDebugLine(null);
        debugState = null;
        shouldContinue = true;
    }
}

// Debug controls event handlers
function initDebugControls() {
    const debugContinue = document.getElementById('debugContinue');
    const debugStepOver = document.getElementById('debugStepOver');
    const debugStepInto = document.getElementById('debugStepInto');
    const debugStop = document.getElementById('debugStop');

    debugContinue.addEventListener('click', () => {
        if (debugState) {
            updateDebugControls(false);
            highlightDebugLine(null);
            debugState = null;
        }
    });

    debugStepOver.addEventListener('click', () => {
        if (debugState) {
            const nextLine = debugState.line + 1;
            debugState.line = nextLine;
            highlightDebugLine(nextLine);
        }
    });

    debugStepInto.addEventListener('click', () => {
        if (debugState) {
            debugState.line = debugState.line + 1;
        }
    });

    debugStop.addEventListener('click', () => {
        if (debugState) {
            updateDebugControls(false);
            highlightDebugLine(null);
            debugState = null;
            // Force error to stop execution
            throw new Error('Debugging stopped');
        }
    });
}

// Function to update debug controls
function updateDebugControls(enabled) {
    const debugControls = document.getElementById('debugControls');
    const debugContinue = document.getElementById('debugContinue');
    const debugStepOver = document.getElementById('debugStepOver');
    const debugStepInto = document.getElementById('debugStepInto');
    const debugStop = document.getElementById('debugStop');
    const debugPanel = document.getElementById('debugPanel');

    debugControls.classList.toggle('active', enabled);
    debugContinue.disabled = !enabled;
    debugStepOver.disabled = !enabled;
    debugStepInto.disabled = !enabled;
    debugStop.disabled = !enabled;
    debugPanel.classList.toggle('active', enabled);
}

// Function to highlight current debug line
function highlightDebugLine(line) {
    if (currentDebugLine !== null) {
        editor.removeLineClass(currentDebugLine, 'background', 'debug-line');
    }
    if (line !== null) {
        editor.addLineClass(line - 1, 'background', 'debug-line');
        currentDebugLine = line - 1;
        editor.scrollIntoView({line: line - 1, ch: 0}, 100);
    }
}

// Function to update variables panel
function updateVariables(L) {
    const debugVariables = document.getElementById('debugVariables');
    debugVariables.innerHTML = '';
    
    if (!debugState || !debugState.ar) return;

    // Get local variables
    let i = 1;
    while (true) {
        const name = fengari.lua.lua_getlocal(L, debugState.ar, i);
        if (name === null) break;
        
        let value;
        if (fengari.lua.lua_isstring(L, -1)) {
            value = fengari.lua.lua_tojsstring(L, -1);
        } else if (fengari.lua.lua_isnumber(L, -1)) {
            value = fengari.lua.lua_tonumber(L, -1);
        } else {
            value = fengari.lua.lua_typename(L, fengari.lua.lua_type(L, -1));
        }

        const varDiv = document.createElement('div');
        varDiv.className = 'debug-variable';
        varDiv.innerHTML = `
            <span class="name">${name}</span>
            <span class="value">${value}</span>
        `;
        debugVariables.appendChild(varDiv);
        fengari.lua.lua_pop(L, 1);
        i++;
    }
}

// Debug hook function
async function debugHook(L, event, line) {
    if (event === 'line' && breakpoints.has(line)) {
        debugState = {
            L: L,
            line: line,
            ar: new fengari.lua.lua_Debug()
        };
        
        if (fengari.lua.lua_getstack(L, 0, debugState.ar)) {
            highlightDebugLine(line);
            updateVariables(L);
            updateDebugControls(true);
            
            return new Promise((resolve) => {
                const debugContinue = document.getElementById('debugContinue');
                const debugStepOver = document.getElementById('debugStepOver');
                const debugStepInto = document.getElementById('debugStepInto');
                const debugStop = document.getElementById('debugStop');

                function cleanup() {
                    updateDebugControls(false);
                    highlightDebugLine(null);
                    debugState = null;
                }

                debugContinue.onclick = () => {
                    cleanup();
                    resolve();
                };

                debugStepOver.onclick = () => {
                    const nextLine = line + 1;
                    highlightDebugLine(nextLine);
                    resolve();
                };

                debugStepInto.onclick = () => {
                    resolve();
                };

                debugStop.onclick = () => {
                    cleanup();
                    throw new Error('Debugging stopped');
                };
            });
        }
    }
}

// Initialize everything when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Content Loaded');
    
    // Initialize CodeMirror first
    editor = CodeMirror.fromTextArea(document.getElementById('editor'), {
        mode: 'lua',
        theme: 'monokai',
        lineNumbers: true,
        gutters: ["CodeMirror-linenumbers", "breakpoints"],
        autoCloseBrackets: true,
        matchBrackets: true,
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: false,
        lineWrapping: false,
        scrollbarStyle: 'native'
    });

    // Create minimap
    createMinimap(editor);

    // Add breakpoint handling
    editor.on("gutterClick", function(cm, n) {
        var info = cm.lineInfo(n);
        cm.setGutterMarker(n, "breakpoints", info.gutterMarkers ? null : makeMarker());
        
        // Update breakpoints set
        if (info.gutterMarkers) {
            breakpoints.delete(n + 1);
        } else {
            breakpoints.add(n + 1);
        }
    });

    // Initialize run button
    const runButton = document.getElementById('runButton');
    runButton.addEventListener('click', () => window.runLuaCode());

    // Initialize open folder button
    const openFolderButton = document.getElementById('openFolderButton');
    openFolderButton.addEventListener('click', openFolder);

    // Initialize other components
    initSplitter();
    initConsole();
    initDebugControls();
    
    // Load initial directory
    loadDirectory(process.cwd());
});

// Function to create breakpoint marker
function makeMarker() {
    var marker = document.createElement("div");
    marker.className = "breakpoint";
    return marker;
}

// Wait for Monaco to be ready
require(['vs/editor/editor.main'], function () {
    console.log('Monaco editor loaded');
    // Register Lua language
    monaco.languages.register({ id: 'lua' });

    // Lua language configuration
    monaco.languages.setLanguageConfiguration('lua', {
        comments: {
            lineComment: '--',
            blockComment: ['--[[', ']]'],
        },
        brackets: [
            ['{', '}'],
            ['[', ']'],
            ['(', ')'],
        ],
        autoClosingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '(', close: ')' },
            { open: '"', close: '"' },
            { open: "'", close: "'" },
        ],
        surroundingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '(', close: ')' },
            { open: '"', close: '"' },
            { open: "'", close: "'" },
        ],
    });

    // Lua language tokens
    monaco.languages.setMonarchTokensProvider('lua', {
        defaultToken: '',
        tokenPostfix: '.lua',

        keywords: [
            'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for',
            'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat',
            'return', 'then', 'true', 'until', 'while'
        ],

        operators: [
            '+', '-', '*', '/', '%', '^', '#', '==', '~=', '<=', '>=', '<', '>', '=',
            ';', ':', ',', '.', '..', '...'
        ],

        symbols: /[=><!~?:&|+\-*\/\^%]+/,
        escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
        digits: /\d+(_+\d+)*/,
        octaldigits: /[0-7]+(_+[0-7]+)*/,
        binarydigits: /[0-1]+(_+[0-1]+)*/,
        hexdigits: /[[0-9a-fA-F]+(_+[0-9a-fA-F]+)*/,

        tokenizer: {
            root: [
                [/[a-zA-Z_]\w*/, {
                    cases: {
                        '@keywords': 'keyword',
                        '@default': 'identifier'
                    }
                }],
                { include: '@whitespace' },
                [/[{}()\[\]]/, '@brackets'],
                [/[<>](?!@symbols)/, '@brackets'],
                [/@symbols/, {
                    cases: {
                        '@operators': 'operator',
                        '@default': ''
                    }
                }],

                // numbers
                [/\d*\.\d+([eE][\-+]?\d+)?/, 'number.float'],
                [/0[xX][0-9a-fA-F]+/, 'number.hex'],
                [/\d+/, 'number'],

                // delimiter: after number because of .\d
                [/[;,.]/, 'delimiter'],

                // strings
                [/"([^"\\]|\\.)*$/, 'string.invalid'],
                [/'([^'\\]|\\.)*$/, 'string.invalid'],
                [/"/, 'string', '@string_double'],
                [/'/, 'string', '@string_single'],
            ],

            whitespace: [
                [/[ \t\r\n]+/, ''],
                [/--\[\[.*\]\]/, 'comment'],
                [/--.*$/, 'comment'],
            ],

            string_double: [
                [/[^\\"]+/, 'string'],
                [/@escapes/, 'string.escape'],
                [/\\./, 'string.escape.invalid'],
                [/"/, 'string', '@pop']
            ],

            string_single: [
                [/[^\\']+/, 'string'],
                [/@escapes/, 'string.escape'],
                [/\\./, 'string.escape.invalid'],
                [/'/, 'string', '@pop']
            ],
        }
    });

    // Create editor
    window.editor = monaco.editor.create(document.getElementById('editor-container'), {
        value: '-- Welcome to Lua Editor\nlocal function hello()\n    print("Hello, World!")\nend\n\nhello()',
        language: 'lua',
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: true },
        fontSize: 14,
        lineNumbers: 'on',
        roundedSelection: false,
        scrollBeyondLastLine: false,
        readOnly: false,
        cursorStyle: 'line',
        selectOnLineNumbers: true,
        contextmenu: true,
        wordWrap: 'on'
    });

    // Handle window resize
    window.addEventListener('resize', () => {
        editor.layout();
    });

    // Initialize file explorer with current directory
    loadDirectory(process.cwd());
});

// Function to get appropriate icon based on file extension
function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    switch (ext) {
        case 'lua':
            return 'code';
        case 'json':
            return 'data_object';
        case 'md':
            return 'description';
        case 'html':
            return 'html';
        case 'js':
            return 'javascript';
        case 'css':
            return 'css';
        case 'gitignore':
        case 'git':
            return 'source_control';
        default:
            return 'description';
    }
} 
