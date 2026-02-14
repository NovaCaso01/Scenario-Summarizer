/**
 * 시나리오 자동요약 - 메시지 가시성 관리
 */

import { getContext } from "../../../../extensions.js";
import { log, getSettings } from './state.js';
import { getSummaryData, getRelevantSummaries } from './storage.js';

// DOM 요소 캐시 (mesid → jQuery 요소)
const messageElementCache = new Map();
let lastChatLength = 0;

/**
 * 메시지 요소 캐시 가져오기/갱신
 * @param {number} mesid - 메시지 인덱스
 * @returns {jQuery} - jQuery 요소
 */
function getMessageElement(mesid) {
    // 캐시에 없으면 조회하여 추가
    if (!messageElementCache.has(mesid)) {
        const $el = $(`.mes[mesid="${mesid}"]`);
        if ($el.length) {
            messageElementCache.set(mesid, $el);
        }
        return $el;
    }
    return messageElementCache.get(mesid);
}

/**
 * 메시지 요소 캐시 초기화 (채팅 변경 시)
 */
export function clearMessageElementCache() {
    messageElementCache.clear();
    lastChatLength = 0;
}

/**
 * 메시지 가시성 적용
 * - 요약된 메시지만 숨김
 * - 유저가 숨긴 메시지는 건드리지 않음
 * - 최근 N개 메시지는 숨기지 않음
 */
export function applyMessageVisibility() {
    const settings = getSettings();
    const context = getContext();
    
    if (!context.chat || context.chat.length === 0) {
        return;
    }
    
    // 채팅 길이가 변경되었으면 캐시 무효화
    if (context.chat.length !== lastChatLength) {
        messageElementCache.clear();
        lastChatLength = context.chat.length;
    }
    
    // Auto-Hide 비활성화면 스킵
    if (!settings.autoHideEnabled) {
        log('자동 숨김 비활성화, 가시성 변경 스킵');
        return;
    }
    
    const data = getSummaryData();
    if (!data) return;
    
    const summaries = data.summaries || {};
    const chatLength = context.chat.length;
    const preserveRecent = settings.preserveRecentMessages || 5;
    const hideThreshold = chatLength - preserveRecent;
    
    log(`Applying visibility: chatLength=${chatLength}, preserveRecent=${preserveRecent}, hideThreshold=${hideThreshold}`);
    
    let hiddenCount = 0;
    let visibleCount = 0;
    
    for (let i = 0; i < chatLength; i++) {
        const msg = context.chat[i];
        const $msgEl = getMessageElement(i);
        
        // 유저가 직접 숨긴 메시지는 건드리지 않음
        if (msg._userHidden) {
            continue;
        }
        
        // 요약이 있고, 최근 N개가 아니면 숨김
        const hasSummary = !!summaries[i];
        const shouldHide = hasSummary && i < hideThreshold;
        
        if (shouldHide) {
            // 숨기기
            if (!msg.is_system) {
                msg.is_system = true;
                msg._summarizedHidden = true; // 우리가 숨겼다는 표시
                if ($msgEl.length) {
                    $msgEl.attr("is_system", "true");
                }
                hiddenCount++;
            }
        } else {
            // 우리가 숨긴 것만 복원 (유저가 숨긴 건 복원하지 않음)
            if (msg.is_system && msg._summarizedHidden) {
                msg.is_system = false;
                delete msg._summarizedHidden;
                if ($msgEl.length) {
                    $msgEl.removeAttr("is_system");
                }
                visibleCount++;
            }
        }
    }
    
    if (hiddenCount > 0 || visibleCount > 0) {
        log(`가시성 업데이트: 숨김=${hiddenCount}, 복원=${visibleCount}`);
    }
}

/**
 * 모든 메시지 가시성 복원 (우리가 숨긴 것만)
 */
export function restoreAllVisibility() {
    const context = getContext();
    
    if (!context.chat) return;
    
    for (let i = 0; i < context.chat.length; i++) {
        const msg = context.chat[i];
        const $msgEl = $(`.mes[mesid="${i}"]`);
        
        // 우리가 숨긴 것만 복원
        if (msg.is_system && msg._summarizedHidden) {
            msg.is_system = false;
            delete msg._summarizedHidden;
            if ($msgEl.length) {
                $msgEl.removeAttr("is_system");
            }
        }
    }
    
    log('요약으로 숨겨진 메시지 모두 복원됨');
}

/**
 * 특정 메시지 숨기기/보이기 토글
 * @param {number} messageIndex 
 * @param {boolean} hide 
 */
export function setMessageVisibility(messageIndex, hide) {
    const context = getContext();
    
    if (!context.chat || messageIndex >= context.chat.length) {
        return;
    }
    
    const msg = context.chat[messageIndex];
    const $msgEl = $(`.mes[mesid="${messageIndex}"]`);
    
    if (hide) {
        msg.is_system = true;
        msg._summarizedHidden = true;
        if ($msgEl.length) {
            $msgEl.attr("is_system", "true");
        }
    } else {
        if (msg._summarizedHidden) {
            msg.is_system = false;
            delete msg._summarizedHidden;
            if ($msgEl.length) {
                $msgEl.removeAttr("is_system");
            }
        }
    }
}

/**
 * 가시성 통계 반환
 * @returns {Object}
 */
export function getVisibilityStats() {
    const context = getContext();
    const summaries = getRelevantSummaries();
    
    if (!context.chat) {
        return { total: 0, summarized: 0, hidden: 0, visible: 0 };
    }
    
    let summarizedCount = 0;
    let hiddenCount = 0;
    let visibleCount = 0;
    
    for (let i = 0; i < context.chat.length; i++) {
        const msg = context.chat[i];
        
        if (summaries[i]) {
            summarizedCount++;
        }
        
        if (msg.is_system) {
            hiddenCount++;
        } else {
            visibleCount++;
        }
    }
    
    return {
        total: context.chat.length,
        summarized: summarizedCount,
        hidden: hiddenCount,
        visible: visibleCount
    };
}
