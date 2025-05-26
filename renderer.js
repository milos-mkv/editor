// Use window.require for Node.js modules in renderer process

console.log('Monaco editor loaded');

const remote = require('@electron/remote');
const { dialog } = remote;
const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');
// ✅ Proceed with your code safely here (loadDirectory, openFile, etc.)
// Example:
console.log('Remote dialog:', dialog);
// ... your logic below ...

let isUpdating = false;
let editor; // CodeMirror instance
let expandedPaths = new Set(); // Keep track of expanded folders
let openFiles = new Map(); // Map of open files: path -> { editor, content }
let activeFile = null; // Currently active file path
let currentLuaProcess = null;

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
            if (!arrow) return;
            
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
            if (!editor) {
                console.error('Editor not initialized');
                return;
            }
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
    const tabBar = document.getElementById('tabBar');
    if (!tabBar) {
        console.error('Tab bar not found');
        return;
    }

    // Remove active class from current tab
    const currentTab = tabBar.querySelector('.tab.active');
    if (currentTab) {
        currentTab.classList.remove('active');
    }

    // Add active class to new tab
    const newTab = tabBar.querySelector(`.tab[data-path="${filePath}"]`);
    if (newTab) {
        newTab.classList.add('active');
        // Ensure the tab is visible by scrolling to it
        newTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }

    // Update editor content
    const fileData = openFiles.get(filePath);
    if (fileData && editor) {
        editor.setValue(fileData.content);
        editor.refresh();
    }

    activeFile = filePath;
}

// Function to close a file
function closeFile(filePath) {
    const tabBar = document.getElementById('tabBar');
    if (!tabBar) {
        console.error('Tab bar not found');
        return;
    }

    const tab = tabBar.querySelector(`.tab[data-path="${filePath}"]`);
    
    if (tab) {
        // If closing active tab, switch to another tab
        if (activeFile === filePath) {
            const nextTab = tab.nextElementSibling || tab.previousElementSibling;
            if (nextTab) {
                switchToFile(nextTab.dataset.path);
            } else {
                // If no other tabs, show welcome screen
                if (editor) {
                    editor.setValue('-- Welcome to Lua Editor\nlocal function hello()\n    print("Hello, World!")\nend\n\nhello()');
                    editor.refresh();
                }
                activeFile = null;
            }
        }
        
        // Remove tab and file data
        tab.remove();
        openFiles.delete(filePath);
    }
}

// Function to open a file
function openFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const tabBar = document.getElementById('tabBar');
        
        if (!tabBar) {
            console.error('Tab bar not found');
            return;
        }

        if (!editor) {
            console.error('Editor not initialized');
            return;
        }
        
        // Create new tab if file isn't already open
        if (!openFiles.has(filePath)) {
            const tab = createTab(filePath);
            
            // Find the active tab and insert the new tab after it
            const activeTab = tabBar.querySelector('.tab.active');
            if (activeTab) {
                activeTab.insertAdjacentElement('afterend', tab);
            } else {
                // If no active tab, append to the end
                tabBar.appendChild(tab);
            }
            
            openFiles.set(filePath, {
                content: content
            });
        }
        
        // Switch to the file
        switchToFile(filePath);
        
        // Update window title
        document.title = `Lua Editor - ${path.basename(filePath)}`;
        
        console.log('File opened successfully:', filePath);
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
    if (!editor || !editor.getWrapperElement()) {
        console.error('Editor not properly initialized');
        return;
    }

    const editorWrapper = editor.getWrapperElement().parentNode;
    if (!editorWrapper) {
        console.error('Editor wrapper not found');
        return;
    }

    // Create minimap container
    const minimapContainer = document.createElement('div');
    minimapContainer.className = 'minimap';
    editorWrapper.appendChild(minimapContainer);

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
    const resizeHandle = document.querySelector('.console-resize-handle');
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    // Handle resize
    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startY = e.clientY;
        startHeight = consoleContainer.offsetHeight;
        document.body.classList.add('dragging');
        resizeHandle.classList.add('dragging');
    });

    consoleHeader.addEventListener('mousedown', (e) => {
        if (e.target === consoleHeader) {
            isResizing = true;
            startY = e.clientY;
            startHeight = consoleContainer.offsetHeight;
            document.body.classList.add('dragging');
            consoleHeader.classList.add('dragging');
        }
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

        // Refresh editor layout
        if (editor && editor.refresh) {
            editor.refresh();
        }

        // Update minimap if exists
        const minimap = document.querySelector('.minimap');
        if (minimap) {
            const minimapEditor = minimap.querySelector('.CodeMirror');
            if (minimapEditor && minimapEditor.CodeMirror) {
                minimapEditor.CodeMirror.refresh();
                // Update minimap slider height
                const slider = document.querySelector('.minimap-slider');
                if (slider) {
                    const editorHeight = editor.getScrollInfo().clientHeight;
                    const totalHeight = editor.getScrollInfo().height;
                    const sliderHeight = (editorHeight / totalHeight) * minimap.clientHeight;
                    slider.style.height = `${sliderHeight}px`;
                }
            }
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.classList.remove('dragging');
            resizeHandle.classList.remove('dragging');
            consoleHeader.classList.remove('dragging');
            
            // Final refresh of editors
            if (editor && editor.refresh) {
                editor.refresh();
            }
        }
    });

    // Toggle console visibility
    closeButton.addEventListener('click', () => {
        consoleContainer.style.display = 'none';
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

// Base Lua execution function
async function runLuaCode() {
    const runButton = document.getElementById('runButton');
    runButton.classList.add('running');
    
    try {
        const code = editor.getValue();
        if (!code.trim()) {
            console.log('No code to execute');
            return;
        }

        // Create child process
        const { fork } = require('child_process');
        const path = require('path');
        currentLuaProcess = fork(path.join(__dirname, 'lua-process.js'));

        // Send start signal to output window
        ipcRenderer.send('lua-output', { type: 'start' });

        // Handle process messages
        currentLuaProcess.on('message', (message) => {
            const { type, data, error } = message;
            
            switch (type) {
                case 'output':
                    // Send to output window instead of console
                    ipcRenderer.send('lua-output', { type: 'output', data });
                    break;
                    
                case 'error':
                    // Send to output window
                    ipcRenderer.send('lua-output', { type: 'error', data: error });
                    cleanup();
                    break;
                    
                case 'done':
                    ipcRenderer.send('lua-output', { type: 'stop' });
                    cleanup();
                    break;
            }
        });

        currentLuaProcess.on('error', (error) => {
            ipcRenderer.send('lua-output', { type: 'error', data: error.message });
            cleanup();
        });

        currentLuaProcess.on('exit', (code) => {
            if (code !== 0 && code !== null) {
                ipcRenderer.send('lua-output', { 
                    type: 'error', 
                    data: `Process exited with code: ${code}` 
                });
            }
            cleanup();
        });

        // Listen for control commands from the output window
        ipcRenderer.on('lua-control', (event, command) => {
            if (command === 'stop') {
                handleStop();
            }
        });

        // Start execution
        currentLuaProcess.send({
            type: 'execute',
            code
        });

    } catch (error) {
        ipcRenderer.send('lua-output', { type: 'error', data: error.message });
        cleanup();
    }
}

function cleanup() {
    if (currentLuaProcess) {
        try {
            currentLuaProcess.kill('SIGKILL');
        } catch (error) {
            ipcRenderer.send('lua-output', { 
                type: 'error', 
                data: `Error killing process: ${error.message}` 
            });
        }
        currentLuaProcess = null;
    }
    const runButton = document.getElementById('runButton');
    runButton.classList.remove('running');
}

// Function to handle stop button click
function handleStop() {
    if (currentLuaProcess) {
        console.log('Stopping execution...');
        currentLuaProcess.send({ type: 'stop' });
        // Force kill after 1 second if process hasn't exited
        setTimeout(() => {
            if (currentLuaProcess) {
                currentLuaProcess.kill('SIGKILL');
                cleanup();
            }
        }, 1000);
    }
}

// Initialize everything when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Content Loaded');
    
    // Initialize CodeMirror first
    const editorTextArea = document.getElementById('editor');
    if (!editorTextArea) {
        console.error('Editor textarea not found');
        return;
    }

    editor = CodeMirror.fromTextArea(editorTextArea, {
        mode: 'lua',
        theme: 'monokai',
        lineNumbers: true,
        autoCloseBrackets: true,
        matchBrackets: true,
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: false,
        lineWrapping: false,
        scrollbarStyle: null
    });

    // Create minimap after ensuring editor is initialized
    if (editor) {
        createMinimap(editor);
    }

    // Initialize run and stop buttons
    const runButton = document.getElementById('runButton');
    const stopButton = document.getElementById('stopButton');
    if (runButton && stopButton) {
        runButton.addEventListener('click', runLuaCode);
        stopButton.addEventListener('click', handleStop);
    }

    // Initialize open folder button
    const openFolderButton = document.getElementById('openFolderButton');
    if (openFolderButton) {
        openFolderButton.addEventListener('click', openFolder);
    }

    // Initialize other components
    initSplitter();
    initConsole();
    
    // Load initial directory
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
