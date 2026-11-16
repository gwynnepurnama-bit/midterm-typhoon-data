// config.js: settings + the LIVE typhoon feature (Taiwan CWA Open Data).
// index.html loads this file first, then calls loadLive(map) inside createMap().

// 1) Paste your own CWA authorization code here. Keep it private (do not post it online).
const CWA_KEY = 'CWA-504979E1-5D2B-424F-A0C7-4C4FB90E2CFB';

// 2) How often to ask the CWA again (in minutes). The CWA updates a few times a day.
const REFRESH_MINUTES = 10;

var liveMarkers = [];     // the LIVE markers that are on the map right now
var knownStorms = [];     // names of the live typhoons we have already seen
var shownStorm = '';      // the live typhoon that is on the charts right now
var mapIsReady = false;   // becomes true when the map style has loaded
var waiting = [];         // things to do as soon as the map is ready

// 3) Turn one CWA typhoon into the same simple records as the files in the data/ folder.
//    We also attach the extra live information to the list: forecast, uncertainty circles, storm size.
function convertCWA(storm) {
    var name = storm.TyphoonName + ' ' + storm.Year + ' (LIVE CWA data)';
    var fixes = storm.AnalysisData.Fix;          // the observed positions, about every 6 hours
    var forecastFixes = storm.ForecastData ? storm.ForecastData.Fix : [];
    var records = [];

    for (var index = 0; index < fixes.length; index++) {
        var fix = fixes[index];
        records.push({
            "DATE": fix.DateTime.slice(0, 10) + ' ' + fix.DateTime.slice(11, 16),
            "NAME": name,
            "LON": parseFloat(fix.CoordinateLongitude),
            "LAT": parseFloat(fix.CoordinateLatitude),
            "WIND": Math.round(parseFloat(fix.MaxWindSpeed) * 1.944),   // CWA gives m/s, we use knots
            "GUST": Math.round(parseFloat(fix.MaxGustSpeed) * 1.944),
            "PRES": parseInt(fix.Pressure)                               // hPa
        });
    }

    var lastFix = fixes[fixes.length - 1];
    var last = records[records.length - 1];

    // the forecast path starts at the latest observed position
    records.forecast = [[last.LON, last.LAT]];
    // the uncertainty circles: [longitude, latitude, radius in km] for each forecast position
    records.cone = [];
    for (var index = 0; index < forecastFixes.length; index++) {
        var f = forecastFixes[index];
        var lon = parseFloat(f.CoordinateLongitude);
        var lat = parseFloat(f.CoordinateLatitude);
        records.forecast.push([lon, lat]);
        if (f.Radius70PercentProbability) {
            records.cone.push([lon, lat, parseFloat(f.Radius70PercentProbability)]);
        }
    }
    // the area with gale-force wind (15 m/s or more) around the typhoon right now
    records.gale = null;
    if (lastFix.Circle15ms) {
        records.gale = [last.LON, last.LAT, parseFloat(lastFix.Circle15ms.Radius)];
    }
    return records;
}

// 4) A circle (radius in km) as a polygon, so it can be drawn on the map.
function circle(lon, lat, radiusKm) {
    var points = [];
    for (var step = 0; step <= 64; step++) {
        var angle = (step / 64) * 2 * Math.PI;
        points.push([
            lon + (radiusKm / (111.32 * Math.cos(lat * Math.PI / 180))) * Math.cos(angle),
            lat + (radiusKm / 111.32) * Math.sin(angle)
        ]);
    }
    return points;
}

// Add a GeoJSON layer the first time, and just replace its data afterwards.
function setLayer(map, id, data, layer) {
    if (map.getSource(id)) {
        map.getSource(id).setData(data);
    } else {
        map.addSource(id, { type: 'geojson', data: data });
        map.addLayer(Object.assign({ id: id, source: id }, layer));
    }
}

// 5) Draw the extra live layers: uncertainty circles, gale-wind area and the dashed forecast path.
function drawLiveExtras(map, records) {
    var polygon = function (c) {
        return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [circle(c[0], c[1], c[2])] } };
    };
    setLayer(map, 'live-cone',
        { type: 'FeatureCollection', features: records.cone.map(polygon) },
        { type: 'fill', paint: { 'fill-color': '#ff7a50', 'fill-opacity': 0.15 } });
    setLayer(map, 'live-gale',
        { type: 'FeatureCollection', features: records.gale ? [polygon(records.gale)] : [] },
        { type: 'fill', paint: { 'fill-color': '#4cc9f0', 'fill-opacity': 0.25 } });
    setLayer(map, 'live-forecast',
        { type: 'Feature', geometry: { type: 'LineString', coordinates: records.forecast } },
        { type: 'line', paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-dasharray': [2, 2] } });
}

// Called by index.html when a normal (saved or sample) typhoon is clicked: remove the live extras.
function clearLiveExtras(map) {
    shownStorm = '';
    var empty = { type: 'FeatureCollection', features: [] };
    var ids = ['live-cone', 'live-gale', 'live-forecast'];
    for (var index = 0; index < ids.length; index++) {
        if (map.getSource(ids[index])) {
            map.getSource(ids[index]).setData(empty);
        }
    }
}

// 6) Show one live typhoon: both charts, its path, the extras, and (if fly is true) move the camera to it.
function showLive(map, records, fly) {
    var last = records[records.length - 1];
    shownStorm = records[0].NAME;
    createTemperatureChart(records, lineChart);
    createWeatherComparisonChart(records, comparisonChart);
    drawTrack(map, records, false);
    drawLiveExtras(map, records);
    if (fly) {
        map.flyTo({ center: [last.LON, last.LAT], zoom: 5, pitch: 55 });
    }
}

// The map style must be loaded before we can draw on it.
function whenMapReady(action) {
    if (mapIsReady) {
        action();
    } else {
        waiting.push(action);
    }
}

// 7) Start the live feature: ask the CWA now, then again every few minutes.
function loadLive(map) {
    map.on('style.load', function () {
        mapIsReady = true;
        for (var index = 0; index < waiting.length; index++) {
            waiting[index]();
        }
        waiting = [];
    });

    if (CWA_KEY.startsWith('PASTE')) {
        document.getElementById('liveStatus').textContent = 'LIVE: add your CWA code in config.js to turn this on';
        return;
    }
    askCWA(map);
    setInterval(function () { askCWA(map); }, REFRESH_MINUTES * 60 * 1000);
}

// 8) Ask the CWA which typhoons are active right now.
function askCWA(map) {
    var status = document.getElementById('liveStatus');

    fetch('https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005?Authorization=' + encodeURIComponent(CWA_KEY))
        .then(function (response) { return response.json(); })
        .then(function (json) {
            var storms = [];
            if (json.records && json.records.TropicalCyclones) {
                storms = json.records.TropicalCyclones.TropicalCyclone || [];
            }

            // remove the old LIVE markers (the typhoons have moved)
            for (const oldMarker of liveMarkers) {
                oldMarker.remove();
            }
            liveMarkers = [];

            if (storms.length === 0) {
                status.textContent = 'LIVE: no active typhoon right now';
                return;
            }

            var newest = null;       // a typhoon we have never seen before
            var onScreen = null;     // the live typhoon that is on the charts, with its newest data
            var names = [];
            var updated = '';

            for (const storm of storms) {
                const records = convertCWA(storm);
                const last = records[records.length - 1];
                names.push(storm.TyphoonName);
                if (updated === '') {
                    updated = last.DATE.slice(5);
                }

                // a pulsing marker at the typhoon's latest position
                const el = document.createElement('div');
                el.innerHTML = '<div class="liveTag">LIVE</div><div class="liveEye">🌀</div>';
                el.style.cursor = 'pointer';
                el.addEventListener('click', function (e) {
                    e.stopPropagation();
                    showLive(map, records, true);
                });
                liveMarkers.push(new mapboxgl.Marker({ element: el }).setLngLat([last.LON, last.LAT]).addTo(map));

                if (knownStorms.indexOf(records[0].NAME) === -1) {
                    knownStorms.push(records[0].NAME);
                    if (newest === null) {
                        newest = records;
                    }
                }
                if (records[0].NAME === shownStorm) {
                    onScreen = records;
                }
            }

            status.textContent = 'LIVE: ' + names.join(', ') + ' (data from ' + updated + ')';

            if (newest !== null) {
                // a new typhoon: show it straight away
                whenMapReady(function () { showLive(map, newest, true); });
            } else if (onScreen !== null) {
                // same typhoon as before: just refresh its charts and path with the newest data
                whenMapReady(function () { showLive(map, onScreen, false); });
            }
        })
        .catch(function (error) {
            console.log(error);
            status.textContent = 'LIVE: could not reach the CWA (blocked or offline)';
        });
}
