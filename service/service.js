module.exports.onStart = function () {
    console.log('Preview service start');
};

module.exports.onRequest = function () {
    console.log('Preview service request');

    var requestedAppControl = tizen.application.getCurrentApplication().getRequestedAppControl();
    if (!requestedAppControl || !requestedAppControl.appControl) {
        console.log('Preview service: no requested app control');
        return;
    }

    var data = requestedAppControl.appControl.data || [];
    var caller = null;

    for (var i = 0; i < data.length; i++) {
        if (data[i].key === 'caller' && data[i].value && data[i].value.length) {
            caller = data[i].value[0];
            break;
        }
    }

    if (requestedAppControl.appControl.operation !== 'http://tizen.org/appcontrol/operation/pick' || caller !== 'JellyfinPreviewProbe') {
        console.log('Preview service: ignoring request', requestedAppControl.appControl.operation, caller);
        return;
    }

    var previewData = {
        sections: [{
            title: 'Continue playing',
            tiles: [{
                title: 'Jellyfin preview probe',
                subtitle: 'Open app from Smart Hub preview',
                image_ratio: '16by9',
                image_url: 'https://developer.samsung.com/onlinedocs/tv/Preview/1.jpg',
                action_data: JSON.stringify({
                    kind: 'resumeProbe',
                    route: '/home.html'
                }),
                is_playable: true
            }]
        }]
    };

    try {
        webapis.preview.setPreviewData(
            JSON.stringify(previewData),
            function () {
                console.log('Preview service: setPreviewData success');
                tizen.application.getCurrentApplication().exit();
            },
            function (error) {
                console.log('Preview service: setPreviewData failed', error && error.message);
            }
        );
    } catch (error) {
        console.log('Preview service: exception', error && error.message);
    }
};

module.exports.onExit = function () {
    console.log('Preview service exit');
};
