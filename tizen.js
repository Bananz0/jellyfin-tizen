(function () {
    'use strict';

    console.log('Tizen adapter');

    // Similar to jellyfin-web
    function generateDeviceId() {
        return btoa([navigator.userAgent, new Date().getTime()].join('|')).replace(/=/g, '1');
    }

    function getDeviceId() {
        // Use variable '_deviceId2' to mimic jellyfin-web

        var deviceId = localStorage.getItem('_deviceId2');

        if (!deviceId) {
            deviceId = generateDeviceId();
            localStorage.setItem('_deviceId2', deviceId);
        }

        return deviceId;
    }

    function getDeviceName() {
        try {
            if (typeof webapis.productinfo.getRealModel === 'function') {
                var model = webapis.productinfo.getRealModel();
                if (model) return model;
            }
        } catch (e) {
            console.warn('getRealModel failed', e);
        }
        return 'Samsung Smart TV';
    }

    var AppInfo = {
        deviceId: getDeviceId(),
        deviceName: getDeviceName(),
        appName: 'Jellyfin for Tizen',
        appVersion: tizen.application.getCurrentApplication().appInfo.version
    };

    // List of supported features
    var SupportedFeatures = [
        'exit',
        'exitmenu',
        'externallinkdisplay',
        'htmlaudioautoplay',
        'htmlvideoautoplay',
        'physicalvolumecontrol',
        'displaylanguage',
        'otherapppromotions',
        'targetblank',
        'screensaver',
        'multiserver',
        'subtitleappearancesettings',
        'subtitleburnsettings'
    ];

    var systeminfo;

    function getSystemInfo() {
        if (systeminfo) {
            return Promise.resolve(systeminfo);
        }

        return new Promise(function (resolve) {
            tizen.systeminfo.getPropertyValue('DISPLAY', function (result) {
                var devicePixelRatio = 1;

                if (typeof webapis.productinfo.is8KPanelSupported === 'function' && webapis.productinfo.is8KPanelSupported()){
                    console.log("8K UHD is supported");
                    devicePixelRatio = 4;
                } else if (typeof webapis.productinfo.isUdPanelSupported === 'function' && webapis.productinfo.isUdPanelSupported()){
                    console.log("4K UHD is supported");
                    devicePixelRatio = 2;
                } else {
                    console.log("UHD is not supported");
                }

                systeminfo = Object.assign({}, result, {
                    resolutionWidth: Math.floor(result.resolutionWidth * devicePixelRatio),
                    resolutionHeight: Math.floor(result.resolutionHeight * devicePixelRatio)
                });

                resolve(systeminfo)
            });
        });
    }

    // Detect panel capabilities once and cache results
    var panelCaps = (function () {
        var is8K = typeof webapis.productinfo.is8KPanelSupported === 'function' && webapis.productinfo.is8KPanelSupported();
        var is4K = typeof webapis.productinfo.isUdPanelSupported === 'function' && webapis.productinfo.isUdPanelSupported();
        var isOled = typeof webapis.productinfo.isOledPanelSupported === 'function' && webapis.productinfo.isOledPanelSupported();

        // isHdrTvSupport is the authoritative check; isUHDAModel is the fallback
        var isHdr10 = false;
        try {
            if (typeof webapis.avinfo.isHdrTvSupport === 'function') {
                isHdr10 = webapis.avinfo.isHdrTvSupport();
            }
        } catch (e) {
            console.warn('isHdrTvSupport failed, falling back to isUHDAModel', e);
        }
        if (!isHdr10 && typeof webapis.productinfo.isUHDAModel === 'function') {
            isHdr10 = webapis.productinfo.isUHDAModel();
        }

        // HDR10+ is Samsung's premium HDR format, supported on 8K and OLED panels
        var isHdr10Plus = isHdr10 && (is8K || isOled);

        // Log detected capabilities
        console.log('Panel caps:', { is8K: is8K, is4K: is4K, isOled: isOled, isHdr10: isHdr10, isHdr10Plus: isHdr10Plus });

        return { is8K: is8K, is4K: is4K, isOled: isOled, isHdr10: isHdr10, isHdr10Plus: isHdr10Plus };
    })();

    // Suppress screensaver during playback, restore it when playback stops
    function setScreenSaver(active) {
        try {
            if (typeof webapis.appcommon.setScreenSaver === 'function') {
                var state = active
                    ? webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON
                    : webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF;
                webapis.appcommon.setScreenSaver(state);
            }
        } catch (e) {
            console.warn('setScreenSaver failed', e);
        }
    }

    function buildProfileOptions(base) {
        var options = Object.assign({}, base);

        // Max video width from physical panel
        if (panelCaps.is8K) {
            options.maxVideoWidth = 7680;
        } else if (panelCaps.is4K) {
            options.maxVideoWidth = 3840;
        }

        if (panelCaps.isHdr10) {
            options.supportsHdr10 = true;
        }

        // HDR10+ is Samsung's own premium HDR format (not Dolby Vision)
        if (panelCaps.isHdr10Plus) {
            options.supportsHdr10Plus = true;
        }

        return options;
    }

    function postMessage() {
        console.log.apply(console, arguments);
    }

    function getPreviewServiceId() {
        try {
            return tizen.application.getCurrentApplication().appInfo.id + '.service';
        } catch (error) {
            console.warn('getPreviewServiceId failed', error);
            return 'AprZAARz4r.Jellyfin.service';
        }
    }

    function launchPreviewService() {
        var serviceId = getPreviewServiceId();

        try {
            tizen.application.launchAppControl(
                new tizen.ApplicationControl(
                    'http://tizen.org/appcontrol/operation/pick',
                    null,
                    null,
                    null,
                    [new tizen.ApplicationControlData('caller', ['JellyfinPreviewProbe'])]
                ),
                serviceId,
                function () {
                    postMessage('Preview service launched', serviceId);
                },
                function (error) {
                    console.warn('Preview service launch failed', error);
                }
            );
        } catch (error) {
            console.warn('launchPreviewService exception', error);
        }
    }

    function getRequestedPreviewActionData() {
        try {
            var requestedAppControl = tizen.application.getCurrentApplication().getRequestedAppControl();
            if (!requestedAppControl || !requestedAppControl.appControl) {
                return null;
            }

            var data = requestedAppControl.appControl.data || [];
            for (var i = 0; i < data.length; i++) {
                if (data[i].key === 'PAYLOAD' && data[i].value && data[i].value.length) {
                    var payload = JSON.parse(data[i].value[0]).values;
                    return JSON.parse(payload);
                }
            }
        } catch (error) {
            console.warn('getRequestedPreviewActionData failed', error);
        }

        return null;
    }

    function handlePreviewActionData(actionData) {
        if (!actionData) {
            return;
        }

        postMessage('Preview action_data', actionData);
        window.__jellyfinPreviewActionData = actionData;

        try {
            sessionStorage.setItem('jellyfin.previewActionData', JSON.stringify(actionData));
        } catch (error) {
            console.warn('Storing preview action_data failed', error);
        }
    }

    function initPreviewProbe() {
        handlePreviewActionData(getRequestedPreviewActionData());

        try {
            if (webapis.preview && typeof webapis.preview.setActionDataEventListener === 'function') {
                var registered = webapis.preview.setActionDataEventListener(function (actionData) {
                    try {
                        handlePreviewActionData(JSON.parse(actionData));
                    } catch (error) {
                        console.warn('Parsing preview callback action_data failed', error, actionData);
                    }
                });

                postMessage('Preview action_data listener registered', registered);
            }
        } catch (error) {
            console.warn('setActionDataEventListener failed', error);
        }

        window.addEventListener('appcontrol', function () {
            handlePreviewActionData(getRequestedPreviewActionData());
        });

        launchPreviewService();
    }

    window.NativeShell = {
        AppHost: {
            init: function () {
                postMessage('AppHost.init', AppInfo);
                return getSystemInfo().then(function () {
                    return Promise.resolve(AppInfo);
                });
            },

            appName: function () {
                postMessage('AppHost.appName', AppInfo.appName);
                return AppInfo.appName;
            },

            appVersion: function () {
                postMessage('AppHost.appVersion', AppInfo.appVersion);
                return AppInfo.appVersion;
            },

            deviceId: function () {
                postMessage('AppHost.deviceId', AppInfo.deviceId);
                return AppInfo.deviceId;
            },

            deviceName: function () {
                postMessage('AppHost.deviceName', AppInfo.deviceName);
                return AppInfo.deviceName;
            },

            exit: function () {
                postMessage('AppHost.exit');
                tizen.application.getCurrentApplication().exit();
            },

            getDefaultLayout: function () {
                postMessage('AppHost.getDefaultLayout', 'tv');
                return 'tv';
            },

            getDeviceProfile: function (profileBuilder) {
                postMessage('AppHost.getDeviceProfile');
                return profileBuilder(buildProfileOptions({
                    enableMkvProgressive: false,
                    enableSsaRender: true
                }));
            },

            getSyncProfile: function (profileBuilder) {
                postMessage('AppHost.getSyncProfile');
                return profileBuilder(buildProfileOptions({
                    enableMkvProgressive: false
                }));
            },

            screen: function () {
                return systeminfo ? {
                    width: systeminfo.resolutionWidth,
                    height: systeminfo.resolutionHeight
                } : null;
            },

            supports: function (command) {
                var isSupported = command && SupportedFeatures.indexOf(command.toLowerCase()) != -1;
                postMessage('AppHost.supports', {
                    command: command,
                    isSupported: isSupported
                });
                return isSupported;
            }
        },

        downloadFile: function (url) {
            postMessage('downloadFile', { url: url });
        },

        enableFullscreen: function () {
            postMessage('enableFullscreen');
        },

        disableFullscreen: function () {
            postMessage('disableFullscreen');
        },

        getPlugins: function () {
            postMessage('getPlugins');
            if (typeof webapis !== 'undefined' && webapis.avplay && window.TizenAVPlayPlayerPlugin) {
                return ['TizenAVPlayPlayerPlugin'];
            }

            return [];
        },

        openUrl: function (url, target) {
            postMessage('openUrl', {
                url: url,
                target: target
            });
        },

        updateMediaSession: function (mediaInfo) {
            postMessage('updateMediaSession', { mediaInfo: mediaInfo });
            // Suppress screensaver while media is active
            setScreenSaver(false);
        },

        hideMediaSession: function () {
            postMessage('hideMediaSession');
            // Restore screensaver when playback ends
            setScreenSaver(true);
        }
    };

    window.addEventListener('load', function () {
        initPreviewProbe();
        tizen.tvinputdevice.registerKey('MediaPlay');
        tizen.tvinputdevice.registerKey('MediaPause');
        tizen.tvinputdevice.registerKey('MediaStop');
        tizen.tvinputdevice.registerKey('MediaTrackPrevious');
        tizen.tvinputdevice.registerKey('MediaTrackNext');
        tizen.tvinputdevice.registerKey('MediaRewind');
        tizen.tvinputdevice.registerKey('MediaFastForward');
        tizen.tvinputdevice.registerKey('ColorF0Red');
        tizen.tvinputdevice.registerKey('ColorF1Green');
        tizen.tvinputdevice.registerKey('ColorF2Yellow');
        tizen.tvinputdevice.registerKey('ColorF3Blue');
    });

    function updateKeys() {
        if (location.hash.indexOf('/queue') !== -1 || location.hash.indexOf('/video') !== -1) {
            // Disable on-screen playback control, if available on the page
            tizen.tvinputdevice.registerKey('MediaPlayPause');
        } else {
            tizen.tvinputdevice.unregisterKey('MediaPlayPause');
        }
    }

    window.addEventListener('viewshow', updateKeys);
})();
