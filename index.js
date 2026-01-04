/**
 * 시나리오 자동요약 확장 프로그램 v1.1.0
 * SillyTavern 네이티브 확장 - chatMetadata 저장 방식
 * 
 * 주요 기능:
 * - 개별 메시지별 요약 저장/수정
 * - 자동 요약 모드
 * - 요약 완료 된 메시지 자동 숨김
 * - 토큰 예산 관리
 * - 분기 대응
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { eventSource, event_types, saveSettingsDebounced } from "../../../../script.js";

// 모듈 import
import { extensionName, extensionFolderPath, defaultSettings } from './src/constants.js';
import { log, setChatLoadingCooldown } from './src/state.js';
import { getSummaryData } from './src/storage.js';
import { registerEventListeners, updateEventListeners, setStatusUpdateCallback } from './src/events.js';
import { applyMessageVisibility } from './src/visibility.js';
import { injectSummaryToPrompt } from './src/injection.js';
import { 
    openPopup, closePopup, bindUIEvents, updateStatusDisplay, updateUIFromSettings, updateApiDisplay, initTokenCounter,
    renderCharactersList, renderEventsList, renderItemsList
} from './src/ui.js';

/**
 * 설정 로드
 */
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    
    // 기본값 적용
    const settings = extension_settings[extensionName];
    
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            if (typeof value === 'object' && value !== null) {
                settings[key] = { ...value };
            } else {
                settings[key] = value;
            }
        }
    }
    
    // categories 깊은 병합 (각 카테고리의 개별 속성도 병합)
    if (!settings.categories) {
        settings.categories = {};
    }
    
    for (const [catKey, defaultCat] of Object.entries(defaultSettings.categories)) {
        if (!settings.categories[catKey]) {
            // 카테고리가 없으면 기본값으로 생성
            settings.categories[catKey] = { ...defaultCat };
        } else if (typeof settings.categories[catKey] === 'object') {
            // 기존 카테고리가 있으면 깊은 병합 (기본값 우선, 기존 설정은 enabled만 유지)
            const existingCat = settings.categories[catKey];
            settings.categories[catKey] = {
                ...defaultCat,
                enabled: existingCat.enabled !== undefined ? existingCat.enabled : defaultCat.enabled,
                // 사용자가 직접 수정한 prompt는 유지 (단, 기존 prompt가 있을 때만)
                prompt: existingCat.prompt !== undefined ? existingCat.prompt : defaultCat.prompt
            };
        } else if (typeof settings.categories[catKey] === 'boolean') {
            // 불리언 형태(구버전)면 새 구조로 변환
            settings.categories[catKey] = {
                ...defaultCat,
                enabled: settings.categories[catKey]
            };
        }
    }
    
    log('Settings loaded');
}

/**
 * 마법봉 메뉴에 버튼 추가
 */
function addExtensionMenuButton(retryCount = 0) {
    const MAX_RETRIES = 10;
    
    // 이미 존재하면 스킵
    if ($("#summarizer-menu-item").length > 0) return;
    
    const extensionsMenu = document.getElementById("extensionsMenu");
    if (!extensionsMenu) {
        if (retryCount < MAX_RETRIES) {
            log(`extensionsMenu not found, retrying... (${retryCount + 1}/${MAX_RETRIES})`);
            setTimeout(() => addExtensionMenuButton(retryCount + 1), 1000);
        } else {
            console.error(`[${extensionName}] extensionsMenu not found after ${MAX_RETRIES} retries`);
        }
        return;
    }
    
    const menuItem = document.createElement("div");
    menuItem.id = "summarizer-menu-item";
    menuItem.className = "list-group-item flex-container flexGap5 interactable";
    menuItem.tabIndex = 0;
    menuItem.role = "listitem";
    menuItem.innerHTML = `
        <div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div>
        시나리오 요약
    `;
    
    menuItem.addEventListener("click", function() {
        openPopup();
        // 메뉴 닫기
        $("#extensionsMenu").hide();
    });
    
    extensionsMenu.appendChild(menuItem);
    log('Menu button added to extensionsMenu');
}

/**
 * 확장 초기화
 */
async function init() {
    log('Extension loading...');
    
    // 설정 로드
    loadSettings();
    
    // 팝업 HTML 로드 - 여러 경로 시도
    const possiblePaths = [
        `${extensionFolderPath}/popup.html`,
        `scripts/extensions/third-party/scenario-summarizer/popup.html`,
        `scripts/extensions/third-party/Scenario-Summarizer/popup.html`,
        `data/default-user/extensions/scenario-summarizer/popup.html`,
        `data/default-user/extensions/Scenario-Summarizer/popup.html`,
    ];
    
    let popupLoaded = false;
    for (const path of possiblePaths) {
        try {
            const popupHtml = await $.get(path);
            $("body").append(popupHtml);
            log(`Popup HTML loaded from: ${path}`);
            popupLoaded = true;
            break;
        } catch (error) {
            log(`Failed to load popup.html from ${path}, trying next...`);
        }
    }
    
    if (!popupLoaded) {
        console.error(`[${extensionName}] Failed to load popup.html from all paths:`, possiblePaths);
        return;
    }
    
    // UI 이벤트 바인딩
    bindUIEvents();
    
    // 토큰 카운터 초기화
    await initTokenCounter();
    
    // 상태 업데이트 콜백 설정
    setStatusUpdateCallback(() => {
        updateStatusDisplay();
        // 도감 탭 데이터도 갱신 (채팅 변경 시)
        renderCharactersList();
        renderEventsList();
        renderItemsList();
    });
    
    // 이벤트 리스너 등록
    registerEventListeners();
    
    // 초기 상태 업데이트
    updateUIFromSettings();
    
    // 메뉴 버튼 추가 (즉시)
    addExtensionMenuButton();
    
    // 채팅 로딩 쿨다운 (초기 로드 시)
    setChatLoadingCooldown(2000);
    
    log('Extension loaded successfully!');
}

// jQuery ready
jQuery(async () => {
    // APP_READY 이벤트 대기
    eventSource.on(event_types.APP_READY, async () => {
        await init();
        
        // 초기 주입 (채팅이 있는 경우)
        setTimeout(async () => {
            const settings = extension_settings[extensionName];
            if (settings.enabled) {
                applyMessageVisibility();
                await injectSummaryToPrompt();
                updateStatusDisplay();
            }
        }, 1000);
    });
});

// 디버그용 전역 객체 (개발/문제해결용)
import { getCharacters, getRelevantCharacters, getEvents, getRelevantEvents, getItems, getRelevantItems, formatCharactersText } from './src/storage.js';
import { getInjectionPreview } from './src/injection.js';

window.SummarizerDebug = {
    getCharacters,
    getRelevantCharacters,
    getEvents,
    getRelevantEvents,
    getItems,
    getRelevantItems,
    formatCharactersText,
    getInjectionPreview,
    getContext,
    getSummaryData
};

// 외부 export (필요시)
export { extensionName };
