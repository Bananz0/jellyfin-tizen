(function () {
    'use strict';

    function getAvplay() {
        if (typeof webapis === 'undefined' || !webapis.avplay) {
            return null;
        }

        return webapis.avplay;
    }

    function safeCall(fn, fallback) {
        try {
            return fn();
        } catch (error) {
            console.warn('AVPlay call failed', error);
            return fallback;
        }
    }

    function getState(avplay) {
        return safeCall(function () {
            return avplay.getState();
        }, 'NONE');
    }

    function stopAndClose(avplay) {
        var state = getState(avplay);

        if (state === 'PLAYING' || state === 'PAUSED' || state === 'READY') {
            safeCall(function () {
                avplay.stop();
            });
            state = getState(avplay);
        }

        if (state !== 'NONE') {
            safeCall(function () {
                avplay.close();
            });
        }
    }

    function createContainer(instance) {
        if (instance._container) {
            return instance._container;
        }

        var container = document.createElement('div');
        container.className = 'avplayPlayerContainer';
        container.style.position = 'fixed';
        container.style.inset = '0';
        container.style.background = 'black';
        container.style.zIndex = '0';
        container.style.pointerEvents = 'none';

        var objectElement = document.createElement('object');
        objectElement.setAttribute('type', 'application/avplayer');
        objectElement.style.position = 'absolute';
        objectElement.style.inset = '0';
        objectElement.style.width = '100%';
        objectElement.style.height = '100%';
        container.appendChild(objectElement);

        document.body.insertBefore(container, document.body.firstChild);
        document.body.classList.add('hide-scroll');

        instance._container = container;
        instance._objectElement = objectElement;
        return container;
    }

    function removeContainer(instance) {
        if (instance._container && instance._container.parentNode) {
            instance._container.parentNode.removeChild(instance._container);
        }

        instance._container = null;
        instance._objectElement = null;
        document.body.classList.remove('hide-scroll');
    }

    function getStreamInfoTracks(mediaSource, type) {
        var streams = (mediaSource && mediaSource.MediaStreams) || [];
        return streams.filter(function (stream) {
            if (stream.Type !== type) {
                return false;
            }

            if (type === 'Subtitle' && stream.IsExternal) {
                return false;
            }

            return true;
        });
    }

    function createTrackMap(mediaSource, avplayTracks, type) {
        var jellyfinTracks = getStreamInfoTracks(mediaSource, type);
        var filteredTracks = avplayTracks.filter(function (track) {
            return track.type === (type === 'Audio' ? 'AUDIO' : 'TEXT');
        });
        var map = {};

        jellyfinTracks.forEach(function (stream, index) {
            if (filteredTracks[index]) {
                map[stream.Index] = filteredTracks[index].index;
            }
        });

        return map;
    }

    function normalizeAspectRatio(aspectRatio) {
        return aspectRatio === 'cover' || aspectRatio === 'fill' ?
            'PLAYER_DISPLAY_MODE_FULL_SCREEN' :
            'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO';
    }

    function getStartPositionMs(streamInfo) {
        return Math.floor((streamInfo && streamInfo.playerStartPositionTicks || 0) / 10000);
    }

    function getDurationMs(streamInfo) {
        if (streamInfo && streamInfo.mediaSource && streamInfo.mediaSource.RunTimeTicks) {
            return Math.floor(streamInfo.mediaSource.RunTimeTicks / 10000);
        }

        if (streamInfo && streamInfo.item && streamInfo.item.RunTimeTicks) {
            return Math.floor(streamInfo.item.RunTimeTicks / 10000);
        }

        return 0;
    }

    class TizenAvplayPlayer {
        constructor(deps) {
            this.name = 'Tizen AVPlay Player';
            this.type = 'mediaplayer';
            this.id = 'tizenavplayplayer';
            this.priority = 0;
            this.isLocalPlayer = true;
            this.supportsProgress = true;

            this._deps = deps;
            this._events = deps.events || window.Events;
            this._appHost = deps.appHost;
            this._appRouter = deps.appRouter;

            this._container = null;
            this._objectElement = null;
            this._streamInfo = null;
            this._currentSrc = null;
            this._currentTimeMs = 0;
            this._durationMs = 0;
            this._isPaused = false;
            this._isMuted = false;
            this._aspectRatio = 'auto';
            this._hasStarted = false;
            this._stopReported = false;
            this._playResolve = null;
            this._playReject = null;
            this._audioTrackMap = {};
            this._subtitleTrackMap = {};
            this._pendingAudioStreamIndex = null;
            this._pendingSubtitleStreamIndex = null;
            this._pendingInitialSeekMs = 0;
            this._initialSeekApplied = true;
            this._initialSeekInFlight = false;
        }

        _trigger(name, args) {
            this._events.trigger(this, name, args || []);
        }

        _rejectPlayback(errorCode) {
            if (this._playReject) {
                this._playReject(errorCode || 'ErrorDefault');
                this._playReject = null;
                this._playResolve = null;
            }
        }

        _resolvePlayback() {
            if (this._playResolve) {
                this._playResolve();
                this._playResolve = null;
                this._playReject = null;
            }
        }

        _reportStopped() {
            if (this._stopReported) {
                return;
            }

            this._stopReported = true;
            this._trigger('stopped', [{
                src: this._currentSrc,
                positionMs: this._currentTimeMs,
                item: this._streamInfo && this._streamInfo.item,
                mediaSource: this._streamInfo && this._streamInfo.mediaSource
            }]);
        }

        _refreshTrackMaps() {
            var avplay = getAvplay();
            if (!avplay || !this._streamInfo || !this._streamInfo.mediaSource) {
                this._audioTrackMap = {};
                this._subtitleTrackMap = {};
                return;
            }

            var tracks = safeCall(function () {
                return avplay.getTotalTrackInfo();
            }, []) || [];

            this._audioTrackMap = createTrackMap(this._streamInfo.mediaSource, tracks, 'Audio');
            this._subtitleTrackMap = createTrackMap(this._streamInfo.mediaSource, tracks, 'Subtitle');
        }

        _applyDisplayMode() {
            var avplay = getAvplay();
            if (!avplay) {
                return;
            }

            safeCall(function () {
                avplay.setDisplayRect(0, 0, 1920, 1080);
            });

            safeCall(function () {
                avplay.setDisplayMethod(normalizeAspectRatio(this._aspectRatio));
            }.bind(this));
        }

        _applyPendingTracks() {
            if (this._pendingAudioStreamIndex != null) {
                this.setAudioStreamIndex(this._pendingAudioStreamIndex);
            }

            if (this._pendingSubtitleStreamIndex != null) {
                this.setSubtitleStreamIndex(this._pendingSubtitleStreamIndex);
            } else {
                this.setSubtitleStreamIndex(-1);
            }
        }

        _showOsd() {
            if (!this._streamInfo || !this._streamInfo.fullscreen || !this._appRouter || !this._appRouter.showVideoOsd) {
                return;
            }

            this._appRouter.showVideoOsd().catch(function (error) {
                console.warn('showVideoOsd failed', error);
            });
        }

        _setListener() {
            var avplay = getAvplay();
            if (!avplay) {
                return;
            }

            avplay.setListener({
                onbufferingstart: function () {
                    console.log('AVPlay buffering start');
                },
                onbufferingprogress: function (percent) {
                    console.log('AVPlay buffering progress', percent);
                },
                onbufferingcomplete: function () {
                    console.log('AVPlay buffering complete');
                },
                oncurrentplaytime: function (currentTime) {
                    this._currentTimeMs = currentTime;

                    if (!this._hasStarted) {
                        this._hasStarted = true;
                        this._refreshTrackMaps();
                        this._applyPendingTracks();
                        this._resolvePlayback();
                        this._showOsd();
                    }

                    if (!this._initialSeekApplied && !this._initialSeekInFlight) {
                        if (Math.abs(currentTime - this._pendingInitialSeekMs) <= 1500) {
                            this._initialSeekApplied = true;
                        } else {
                            this._initialSeekInFlight = true;
                            console.log('AVPlay initial seek', {
                                currentTime: currentTime,
                                targetTime: this._pendingInitialSeekMs
                            });

                            safeCall(function () {
                                avplay.seekTo(this._pendingInitialSeekMs, function () {
                                    this._currentTimeMs = this._pendingInitialSeekMs;
                                    this._initialSeekApplied = true;
                                    this._initialSeekInFlight = false;
                                    this._trigger('timeupdate');
                                }.bind(this), function (error) {
                                    console.warn('AVPlay initial seek failed', error);
                                    this._initialSeekApplied = true;
                                    this._initialSeekInFlight = false;
                                }.bind(this));
                            }.bind(this));
                        }
                    }

                    this._trigger('timeupdate');
                }.bind(this),
                onstreamcompleted: function () {
                    this._currentTimeMs = this._durationMs || this._currentTimeMs;
                    this._reportStopped();
                }.bind(this),
                onerror: function (error) {
                    console.warn('AVPlay error', error);
                    this._rejectPlayback('ErrorDefault');
                }.bind(this),
                onerrormsg: function (error, message) {
                    console.warn('AVPlay error message', error, message);
                    this._rejectPlayback('ErrorDefault');
                }.bind(this)
            });
        }

        _prepare(streamInfo) {
            var avplay = getAvplay();
            if (!avplay) {
                this._rejectPlayback('ErrorDefault');
                return;
            }

            this._setListener();
            stopAndClose(avplay);

            createContainer(this);

            safeCall(function () {
                avplay.open(streamInfo.url);
            });

            this._applyDisplayMode();

            avplay.prepareAsync(function () {
                this._durationMs = safeCall(function () {
                    return avplay.getDuration();
                }, this._durationMs || getDurationMs(streamInfo)) || getDurationMs(streamInfo);

                var startPositionMs = getStartPositionMs(streamInfo);
                this._pendingInitialSeekMs = startPositionMs > 0 ? startPositionMs : 0;
                this._initialSeekApplied = this._pendingInitialSeekMs <= 0;
                this._initialSeekInFlight = false;

                console.log('AVPlay prepared', {
                    state: getState(avplay),
                    durationMs: this._durationMs,
                    startPositionMs: this._pendingInitialSeekMs
                });

                safeCall(function () {
                    avplay.play();
                    console.log('AVPlay play called', {
                        state: getState(avplay)
                    });
                });
                this._isPaused = false;
            }.bind(this), function (error) {
                console.warn('AVPlay prepareAsync failed', error);
                this._rejectPlayback('ErrorDefault');
            }.bind(this));
        }

        canPlayMediaType(mediaType) {
            return (mediaType || '').toLowerCase() === 'video';
        }

        canPlayItem(item) {
            var canPlay = !!getAvplay() && this.canPlayMediaType(item && item.MediaType);
            if (canPlay) {
                console.log('AVPlay plugin canPlayItem', item && item.Name, item && item.Type);
            }
            return canPlay;
        }

        getDeviceProfile(item, options) {
            if (this._appHost && this._appHost.getDeviceProfile) {
                return this._appHost.getDeviceProfile(item, options);
            }

            return Promise.resolve({});
        }

        play(streamInfo) {
            this.destroy();

            this._streamInfo = streamInfo;
            this._currentSrc = streamInfo.url;
            this._currentTimeMs = getStartPositionMs(streamInfo);
            this._durationMs = getDurationMs(streamInfo);
            this._isPaused = false;
            this._hasStarted = false;
            this._stopReported = false;
            this._pendingAudioStreamIndex = streamInfo.mediaSource ? streamInfo.mediaSource.DefaultAudioStreamIndex : null;
            this._pendingSubtitleStreamIndex = streamInfo.mediaSource ? streamInfo.mediaSource.DefaultSubtitleStreamIndex : null;

            console.log('AVPlay plugin play', {
                url: streamInfo.url,
                mimeType: streamInfo.mimeType,
                playMethod: streamInfo.playMethod,
                startPositionMs: this._currentTimeMs
            });

            return new Promise(function (resolve, reject) {
                this._playResolve = resolve;
                this._playReject = reject;
                this._prepare(streamInfo);
            }.bind(this));
        }

        stop(destroyPlayer) {
            var avplay = getAvplay();
            if (avplay) {
                safeCall(function () {
                    avplay.stop();
                });
            }

            this._isPaused = false;
            this._reportStopped();

            if (destroyPlayer) {
                this.destroy();
            }

            return Promise.resolve();
        }

        destroy() {
            var avplay = getAvplay();
            if (avplay) {
                stopAndClose(avplay);
            }

            this._playResolve = null;
            this._playReject = null;
            this._audioTrackMap = {};
            this._subtitleTrackMap = {};
            this._pendingAudioStreamIndex = null;
            this._pendingSubtitleStreamIndex = null;
            this._pendingInitialSeekMs = 0;
            this._initialSeekApplied = true;
            this._initialSeekInFlight = false;
            this._streamInfo = null;
            this._currentSrc = null;
            this._currentTimeMs = 0;
            this._durationMs = 0;
            this._isPaused = false;
            this._hasStarted = false;
            this._stopReported = false;

            removeContainer(this);
        }

        pause() {
            var avplay = getAvplay();
            if (avplay) {
                safeCall(function () {
                    avplay.pause();
                });
            }

            this._isPaused = true;
            this._trigger('pause');
        }

        unpause() {
            var avplay = getAvplay();
            if (avplay) {
                safeCall(function () {
                    avplay.play();
                });
            }

            this._isPaused = false;
            this._trigger('unpause');
        }

        paused() {
            return this._isPaused;
        }

        currentTime(val) {
            var avplay = getAvplay();

            if (val != null && avplay) {
                this._currentTimeMs = Math.max(0, Math.floor(val));
                safeCall(function () {
                    avplay.seekTo(this._currentTimeMs);
                }.bind(this));
                this._trigger('timeupdate');
            }

            return this._currentTimeMs;
        }

        duration() {
            return this._durationMs;
        }

        seekable() {
            return !!this._durationMs;
        }

        getBufferedRanges() {
            return [];
        }

        canSetAudioStreamIndex() {
            return true;
        }

        setAudioStreamIndex(index) {
            this._pendingAudioStreamIndex = index;

            var avplay = getAvplay();
            var trackIndex = this._audioTrackMap[index];
            if (!avplay || trackIndex == null) {
                return;
            }

            safeCall(function () {
                avplay.setSelectTrack('AUDIO', trackIndex);
            });
        }

        setSubtitleStreamIndex(index) {
            this._pendingSubtitleStreamIndex = index;

            var avplay = getAvplay();
            if (!avplay) {
                return;
            }

            if (index == null || index < 0) {
                safeCall(function () {
                    avplay.setSilentSubtitle(true);
                });
                return;
            }

            var trackIndex = this._subtitleTrackMap[index];
            if (trackIndex == null) {
                return;
            }

            safeCall(function () {
                avplay.setSilentSubtitle(false);
            });

            safeCall(function () {
                avplay.setSelectTrack('TEXT', trackIndex);
            });
        }

        supports(feature) {
            return feature === 'SetAspectRatio';
        }

        setAspectRatio(val) {
            this._aspectRatio = val || 'auto';
            this._applyDisplayMode();
        }

        getAspectRatio() {
            return this._aspectRatio;
        }

        getSupportedAspectRatios() {
            return [{
                name: this._deps.globalize.translate('Auto'),
                id: 'auto'
            }, {
                name: this._deps.globalize.translate('AspectRatioCover'),
                id: 'cover'
            }, {
                name: this._deps.globalize.translate('AspectRatioFill'),
                id: 'fill'
            }];
        }

        getVolume() {
            return 1;
        }

        setVolume() {
        }

        volumeUp() {
        }

        volumeDown() {
        }

        isMuted() {
            return this._isMuted;
        }

        setMute(muted) {
            this._isMuted = !!muted;
        }
    }

    window.TizenAVPlayPlayerPlugin = async function () {
        return TizenAvplayPlayer;
    };
})();
