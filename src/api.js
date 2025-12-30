/**
 * 시나리오 자동요약 - API 호출 로직
 */

import { extension_settings } from "../../../../extensions.js";
import { main_api, generateQuietPrompt, generateRaw } from "../../../../../script.js";
import { extensionName, API_SOURCE } from './constants.js';
import { log, getSettings, logError } from './state.js';

// ConnectionManagerRequestService (SillyTavern 1.13.0+)
let ConnectionManagerRequestService = null;

/**
 * ConnectionManagerRequestService 로드 시도
 */
async function loadConnectionManager() {
    if (ConnectionManagerRequestService) return true;
    
    try {
        const shared = await import("../../../shared.js");
        ConnectionManagerRequestService = shared.ConnectionManagerRequestService;
        log('ConnectionManagerRequestService loaded');
        return true;
    } catch (error) {
        log(`ConnectionManagerRequestService not available: ${error.message}`);
        return false;
    }
}

/**
 * 요약 API 호출 (메인 진입점)
 * @param {string} prompt - 요약 프롬프트
 * @returns {Promise<string>}
 */
export async function callSummaryAPI(prompt) {
    const settings = getSettings();
    
    if (settings.apiSource === API_SOURCE.CUSTOM) {
        return await callCustomAPI(prompt);
    } else {
        // SillyTavern API - Connection Profile 사용 가능 여부 확인
        if (settings.stConnectionProfile) {
            return await callConnectionManagerAPI(prompt);
        }
        return await callSillyTavernAPI(prompt);
    }
}

/**
 * SillyTavern Connection Manager API 호출
 * @param {string} prompt 
 * @returns {Promise<string>}
 */
async function callConnectionManagerAPI(prompt) {
    const settings = getSettings();
    
    const loaded = await loadConnectionManager();
    if (!loaded || !ConnectionManagerRequestService) {
        log('ConnectionManager not available, falling back to default API');
        return await callSillyTavernAPI(prompt);
    }
    
    const profileId = settings.stConnectionProfile;
    
    // 프로필이 존재하는지 확인
    const profiles = extension_settings?.connectionManager?.profiles || [];
    const profile = profiles.find(p => p.id === profileId);
    
    if (!profile) {
        log(`Profile ${profileId} not found, falling back to default API`);
        return await callSillyTavernAPI(prompt);
    }
    
    try {
        // 설정에서 응답 토큰 수 가져오기 (0 또는 미설정 = 프리셋 설정 사용)
        const maxTokens = settings.maxResponseTokens || null;
        log(`Using ConnectionManager profile: ${profile.name} (maxTokens: ${maxTokens || 'preset default'})`);
        
        const messages = [
            {
                role: 'system',
                content: 'You are a helpful assistant that summarizes roleplay scenarios. Respond in the requested format only.'
            },
            { role: 'user', content: prompt }
        ];
        
        const result = await ConnectionManagerRequestService.sendRequest(
            profileId,
            messages,
            maxTokens,
            {
                includePreset: true,
                includeInstruct: true,
                stream: false
            },
            {} // override payload
        );
        
        const content = result?.content || result || '';
        
        if (!content) {
            throw new Error('Empty response from ConnectionManager');
        }
        
        return content;
    } catch (error) {
        log(`ConnectionManager API error: ${error.message}`);
        throw error;
    }
}

/**
 * SillyTavern 내장 API 호출
 * @param {string} prompt 
 * @returns {Promise<string>}
 */
async function callSillyTavernAPI(prompt) {
    const settings = getSettings();
    
    try {
        let result;
        
        if (settings.useRawPrompt && typeof generateRaw === 'function') {
            // Raw 프롬프트: 채팅 히스토리 제외, 월드인포 포함 여부는 설정에 따름
            result = await generateRaw({
                prompt: prompt,
                maxContext: null,
                quietToLoud: false,
                skipWIAN: !settings.includeWorldInfo,
                skipAN: true,
                quietImage: null,
                quietName: null
            });
        } else if (typeof generateQuietPrompt === 'function') {
            // Quiet 프롬프트
            result = await generateQuietPrompt(prompt, false, false);
        } else {
            throw new Error("SillyTavern API 함수를 찾을 수 없습니다");
        }
        
        return result || '';
    } catch (error) {
        log(`SillyTavern API error: ${error.message}`);
        logError('callSillyTavernAPI', error);
        throw error;
    }
}

/**
 * 커스텀 API 호출 (OpenAI 호환)
 * @param {string} prompt 
 * @returns {Promise<string>}
 */
async function callCustomAPI(prompt) {
    const settings = getSettings();
    
    if (!settings.customApiUrl || !settings.customApiModel) {
        throw new Error("커스텀 API 설정이 필요합니다");
    }
    
    const headers = { 
        "Content-Type": "application/json" 
    };
    
    if (settings.customApiKey) {
        headers["Authorization"] = `Bearer ${settings.customApiKey}`;
    }
    
    try {
        const controller = new AbortController();
        const timeout = (settings.customApiTimeout || 60) * 1000; // 설정에서 타임아웃 가져오기 (기본 60초)
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        const maxTokens = settings.customApiMaxTokens || 4000; // 설정에서 max_tokens 가져오기
        const model = settings.customApiModel.toLowerCase();
        
        // OpenAI 새 모델들은 max_completion_tokens 사용
        // o1, o1-mini, o1-preview, o3, o3-mini 및 최신 gpt-4o 모델들
        const useMaxCompletionTokens = /^(o1|o3|gpt-4o-2024-1[12])/.test(model) || 
                                        model.includes('o1-') || 
                                        model.includes('o3-');
        
        const requestBody = {
            model: settings.customApiModel,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3
        };
        
        // 토큰 파라미터 선택
        if (useMaxCompletionTokens) {
            requestBody.max_completion_tokens = maxTokens;
            log(`Using max_completion_tokens for model: ${settings.customApiModel}`);
        } else {
            requestBody.max_tokens = maxTokens;
        }
        
        const response = await fetch(settings.customApiUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        return data.choices?.[0]?.message?.content || data.content || "";
    } catch (error) {
        log(`Custom API error: ${error.message}`);
        logError('callCustomAPI', error, { url: settings.customApiUrl, model: settings.customApiModel });
        throw error;
    }
}

/**
 * 모델 목록 로드 (커스텀 API)
 * @returns {Promise<Array>}
 */
export async function loadModels() {
    const settings = getSettings();
    const url = settings.customApiUrl;
    const key = settings.customApiKey;
    
    if (!url) {
        throw new Error("API URL이 필요합니다");
    }
    
    // /chat/completions → /models 로 변환
    const modelsUrl = url.replace(/\/chat\/completions\/?$/, "/models");
    
    const headers = {};
    if (key) {
        headers["Authorization"] = `Bearer ${key}`;
    }
    
    const response = await fetch(modelsUrl, { headers });
    
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    const models = data.data || data.models || [];
    
    return models.map(model => model.id || model.name || model);
}

/**
 * API 연결 테스트
 * @returns {Promise<boolean>}
 */
export async function testApiConnection() {
    try {
        const result = await callSummaryAPI("테스트: 이 메시지에 '연결 성공'이라고 답하세요.");
        return !!result;
    } catch (error) {
        log(`API test failed: ${error.message}`);
        throw error;
    }
}

/**
 * 현재 API 상태 정보 반환
 * @returns {Object}
 */
export function getApiStatus() {
    const settings = getSettings();
    
    if (settings.apiSource === API_SOURCE.SILLYTAVERN) {
        // Connection Profile 사용 중인지 확인
        if (settings.stConnectionProfile) {
            const profiles = extension_settings?.connectionManager?.profiles || [];
            const profile = profiles.find(p => p.id === settings.stConnectionProfile);
            
            if (profile) {
                return {
                    source: "sillytavern",
                    connected: true,
                    displayName: `프로필: ${profile.name}`,
                    profileId: profile.id
                };
            }
        }
        
        const apiName = main_api || "연결 안됨";
        const displayNames = {
            "openai": "OpenAI",
            "textgenerationwebui": "Text Generation WebUI",
            "kobold": "KoboldAI",
            "novel": "NovelAI",
            "claude": "Claude",
            "palm": "PaLM",
            "openrouter": "OpenRouter"
        };
        
        return {
            source: "sillytavern",
            connected: !!main_api,
            displayName: displayNames[apiName] || apiName
        };
    } else {
        const hasConfig = settings.customApiUrl && settings.customApiModel;
        
        // 프리셋 이름 표시
        let displayName = settings.customApiModel || "설정 필요";
        if (settings.selectedPreset) {
            displayName = `${settings.selectedPreset} (${settings.customApiModel})`;
        }
        
        return {
            source: "custom",
            connected: hasConfig,
            displayName: displayName,
            url: settings.customApiUrl
        };
    }
}
