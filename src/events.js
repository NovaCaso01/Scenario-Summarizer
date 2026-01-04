/**
 * 시나리오 자동요약 - 이벤트 핸들러
 */

import { eventSource, event_types } from "../../../../../script.js";
import { extension_settings } from "../../../../extensions.js";
import { extensionName } from './constants.js';
import { log, getSettings, setChatLoadingCooldown, isChatLoadingCooldown, setGenerationLock, clearGenerationLock, isGenerationInProgress, isSummarizing, logError } from './state.js';
import { getSummaryData, saveSummaryData, remapSummariesAfterDeletion, invalidateSummaryOnSwipe } from './storage.js';
import { runAutoSummary } from './summarizer.js';
import { applyMessageVisibility, clearMessageElementCache } from './visibility.js';
import { injectSummaryToPrompt, clearInjection } from './injection.js';

// UI 업데이트 콜백 (index.js에서 설정)
let onStatusUpdateCallback = null;

/**
 * UI 업데이트 콜백 설정
 * @param {Function} callback 
 */
export function setStatusUpdateCallback(callback) {
    onStatusUpdateCallback = callback;
}

/**
 * 상태 업데이트 트리거
 */
function triggerStatusUpdate() {
    if (onStatusUpdateCallback) {
        onStatusUpdateCallback();
    }
}

/**
 * 채팅 변경 이벤트 핸들러
 */
async function onChatChanged() {
    const settings = getSettings();
    
    log('채팅 변경됨');
    
    // 채팅 로딩 쿨다운 설정
    setChatLoadingCooldown(2000);
    
    // 메시지 요소 캐시 초기화
    clearMessageElementCache();
    
    // 가시성 적용
    setTimeout(async () => {
        applyMessageVisibility();
        
        // 활성화 상태면 주입
        if (settings.enabled) {
            await injectSummaryToPrompt();
        } else {
            clearInjection();
        }
        
        triggerStatusUpdate();
    }, 500);
}

/**
 * 메시지 수신 이벤트 핸들러 (AI 응답 후)
 * @param {number} messageId 
 */
async function onMessageReceived(messageId) {
    const settings = getSettings();
    
    log(`메시지 수신: id=${messageId}, enabled=${settings.enabled}, automaticMode=${settings.automaticMode}`);
    
    // 비활성화, 수동 모드, 쿨다운 중이면 스킵
    if (!settings.enabled || !settings.automaticMode) {
        log('자동 요약 스킵: 비활성화 또는 수동 모드');
        return;
    }
    
    if (isChatLoadingCooldown()) {
        log('자동 요약 스킵: 채팅 로딩 쿨다운 중');
        return;
    }
    
    if (isSummarizing()) {
        log('자동 요약 스킵: 이미 요약 중');
        return;
    }
    
    if (isGenerationInProgress()) {
        log('자동 요약 스킵: AI 생성 진행 중');
        return;
    }
    
    log('자동 요약 실행 중...');
    // 자동 요약 실행
    await runAutoSummary();
    triggerStatusUpdate();
}

/**
 * 생성 시작 이벤트 핸들러
 */
function onGenerationStarted() {
    setGenerationLock();
    log('AI 생성 시작');
}

/**
 * 생성 종료 이벤트 핸들러
 */
function onGenerationEnded() {
    clearGenerationLock();
    log('AI 생성 종료');
}

/**
 * 생성 종료 + 자동 요약 체크 핸들러
 */
async function onGenerationEndedWithAutoSummary() {
    clearGenerationLock();
    log('AI 생성 종료, 자동 요약 확인 중...');
    
    const settings = getSettings();
    
    // 비활성화, 수동 모드면 스킵
    if (!settings.enabled || !settings.automaticMode) {
        log('자동 요약 스킵: 비활성화 또는 수동 모드');
        return;
    }
    
    if (isChatLoadingCooldown()) {
        log('자동 요약 스킵: 채팅 로딩 쿨다운 중');
        return;
    }
    
    // 약간의 딜레이 후 자동 요약 실행 (채팅 데이터 업데이트 대기)
    setTimeout(async () => {
        try {
            if (isSummarizing()) {
                log('자동 요약 스킵: 이미 요약 중');
                return;
            }
            
            log('GENERATION_ENDED에서 자동 요약 실행 중...');
            await runAutoSummary();
            triggerStatusUpdate();
        } catch (error) {
            console.error('[scenario-summarizer] 자동 요약 오류:', error);
        }
    }, 500);
}

/**
 * 메시지 스와이프 이벤트 핸들러
 * 스와이프 시 해당 메시지의 요약을 삭제/무효화
 * @param {number} messageId 
 */
async function onMessageSwiped(messageId) {
    log(`Message swiped: id=${messageId}`);
    
    // 해당 메시지의 요약 무효화
    invalidateSummaryOnSwipe(messageId);
    await saveSummaryData();
    
    // 주입 갱신
    await injectSummaryToPrompt();
    triggerStatusUpdate();
}

/**
 * 메시지 삭제 이벤트 핸들러
 * 삭제 시 요약 인덱스 재매핑
 * @param {number} messageId 
 */
async function onMessageDeleted(messageId) {
    log(`Message deleted: id=${messageId}`);
    
    // 요약 인덱스 재매핑
    remapSummariesAfterDeletion(messageId);
    await saveSummaryData();
    
    // 주입 갱신
    await injectSummaryToPrompt();
    triggerStatusUpdate();
}

/**
 * 생성 전 이벤트 핸들러 (컨텍스트 주입)
 */
async function onBeforeGeneration() {
    const settings = getSettings();
    
    if (!settings.enabled) {
        return;
    }
    
    // 생성 전에 요약 주입 갱신
    await injectSummaryToPrompt();
}

// 이벤트 리스너 등록 상태
let listenersRegistered = false;

/**
 * 이벤트 리스너 등록
 */
export function registerEventListeners() {
    if (listenersRegistered) {
        log('이벤트 리스너 이미 등록됨');
        return;
    }
    
    // 채팅 변경
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    
    // 메시지 수신 (AI 응답 후) - 여러 이벤트 타입 시도
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    
    // MESSAGE_SWIPED - 스와이프 시 해당 요약 무효화
    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    }
    
    // MESSAGE_DELETED - 메시지 삭제 시 인덱스 재매핑
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    }
    
    // GENERATION_ENDED 에서도 자동 요약 체크
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEndedWithAutoSummary);
    
    // 생성 전 (컨텍스트 주입)
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onBeforeGeneration);
    
    listenersRegistered = true;
    log('Event listeners registered');
}

/**
 * 이벤트 리스너 해제
 */
export function unregisterEventListeners() {
    if (!listenersRegistered) {
        return;
    }
    
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.removeListener(event_types.MESSAGE_RECEIVED, onMessageReceived);
    if (event_types.MESSAGE_SWIPED) {
        eventSource.removeListener(event_types.MESSAGE_SWIPED, onMessageSwiped);
    }
    if (event_types.MESSAGE_DELETED) {
        eventSource.removeListener(event_types.MESSAGE_DELETED, onMessageDeleted);
    }
    eventSource.removeListener(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.removeListener(event_types.GENERATION_ENDED, onGenerationEndedWithAutoSummary);
    eventSource.removeListener(event_types.GENERATION_AFTER_COMMANDS, onBeforeGeneration);
    
    listenersRegistered = false;
    log('Event listeners unregistered');
}

/**
 * 설정에 따라 이벤트 리스너 업데이트
 */
export async function updateEventListeners() {
    const settings = getSettings();
    
    if (settings.enabled) {
        registerEventListeners();
        await injectSummaryToPrompt();
    } else {
        // 비활성화 시에도 기본 리스너는 유지 (채팅 변경 감지용)
        // 대신 주입만 제거
        clearInjection();
    }
    
    log(`Event listeners updated: enabled=${settings.enabled}, automaticMode=${settings.automaticMode}`);
}
