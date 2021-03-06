(function(){
var print = require("josm/util").println;
var builder= require("josm/builder");
var command = require("josm/command");
var FATAL = false; // If true, fatal error. Abort.

var VERBOSE_MODE = false; // set to true to print everything
var PRINT_CREATE_DELETE = false;  // set to true to print all creations/deletions. Implicitly true if verbose mode is true.
var DB_DIR = "/home/osm/openStreetMap/gtfs/";

/*
Script page and documentation: https://wiki.openstreetmap.org/wiki/User:SafwatHalaby/scripts/gtfs
Last update: 20 Dec 2017
major version: 1

[out:xml][timeout:90][bbox:29.5734571,34.1674805,33.4131022,35.925293];
(
area(3601473946);
area(3603791785);
)->.a;
(
  node["highway"="bus_stop"](area.a);
  way["highway"="bus_stop"](area.a);
);
out meta;
*/
//3601473946 - IL. 3603791785 - area C
/*


*/

// TODO DESYNC logging for pos changes
// log coordinates in all DESYNC logs



////////////////////////////// File functions

function readFile_forEach(path, forEach)
{
	var File = java.io.File;
	var BufferedReader = java.io.BufferedReader;
	var FileReader = java.io.FileReader;
	var file = new File(path);
	var br = new BufferedReader(new FileReader(file));
	var line;
	while ((line = br.readLine()) != null)
	{
	  forEach(line);
	}
	br.close();
}

function lineToGtfsEntry(line)
{
	if (line.indexOf("רחוב:מסילת ברזל  עיר") !== -1) return null;  // temporary hack to ignore train stations
	if (line.trim() === "") return null; //whitespace-only line
	var arr = line.replace(/\s+/g, ' ').split(",");
	var gtfsEntry = {};
	gtfsEntry["ref"] = arr[0].trim();         // stop_code
	gtfsEntry["name"] = arr[1].trim();        // stop_name
	gtfsEntry["name:he"] = gtfsEntry["name"]; // stop_name (he)
	gtfsEntry["description"] = arr[2].replace(" רציף:   קומה:  ", "").trim(); // stop_desc
	gtfsEntry["lat"] = Number(arr[3].trim()); // stop_lat
	gtfsEntry["lon"] = Number(arr[4].trim()); // stop_lon
	return gtfsEntry;
}




////////////////////////////// Small helper functions

function printV(str)
{
	if (VERBOSE_MODE === true) print(str);
}

function printCD(str)
{
	if ((VERBOSE_MODE === true) || (PRINT_CREATE_DELETE === true)) print(str);
}

function del(p, layer)
{
	layer.apply(command.delete(p));
}

// source https://stackoverflow.com/questions/27928/calculate-distance-between-two-latitude-longitude-points-haversine-formula
function getDistanceFromLatLonInM(lat1,lon1,lat2,lon2) {
  var R = 6371; // Radius of the earth in km
  var dLat = deg2rad(lat2-lat1);  // deg2rad below
  var dLon = deg2rad(lon2-lon1); 
  var a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2)
    ; 
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  var d = R * c; // Distance in km
  return d * 1000;
}

function deg2rad(deg) {
  return deg * (Math.PI/180)
}

// Rhino/JOSM script plugin doesn't seem to have pretty printing for debugging
// I made this simple alternative. Similar to browsers' console.log(object)
function printObj(obj,indent)
{
	if (indent === undefined) indent = "";
	else indent = indent + " ";
	
	if (obj instanceof Array)
	{
		print(indent+"[");
		for (var i = 0; i < obj.length; ++i)
			printObj(obj[i], indent);
		print(indent+"]");
	}
	else if (obj instanceof Object)
	{
		print(indent+"(");
		for (var key in obj)
		{
			if (obj.hasOwnProperty(key)) 
			{
				print(indent+key+": ");
				printObj(obj[key], indent);
			}
		}
		print(indent+")");
	}
	else // POD
	{
		print(indent+obj);
	}
}

////////////////////////////// Stats




var gStats = {
	ddx_del: 0, ddx_nothing: 0, dxd_create: 0, dxx_update: 0, xdd_nothing: 0, xdx_delete: 0, xxd_create: 0, xxd_nothing: 0, xxx_update: 0,
	update: 0,                        /* Total updates (update_touched + update_not_touched) */
	update_touched: 0                 /* Total updates that actually changed something */,
	update_not_touched: 0,            /* Total bus stop update attempts that didn't need to change any tags */
	update_distanceTooFar_skipped: 0, /* Total updates that were skipped because the position changed significantly */
	update_distanceTooFar_ignored: 0, /* Total updates that were done despite the position changing significantly */
	create: 0,                        /* Total created stops (dxd_create+xxd_create) */
	del: 0,                           /* Total deleted stops (ddx_del+xdx_delete) */
	nothing: 0,                       /* Total stops where no action was taken (xdd_nothing+ddx_nothing+xxd_nothing) */
	touched: 0,                       /* create + del + update_touched */
	total_newGTFS: 0,                 /* total bus stop lines in the new GTFS file. */
	total_oldGTFS: 0,                 /* total bus stop lines in the old GTFS file */
	total_OsmBeforeRun: 0,            /* Total "ref" carrying stops in Israel, prior to the run */
	total_OsmAfterRun: 0              /* Total "ref" carrying stops in Israel, after the run (total_OsmBeforeRun+created-deleted) */ 
	//note: total_OsmAfterRun = total_newGTFS + ddx_nothing (ref carrying stops that aren't from gtfs DB)
}



////////////////////////////// MAIN

function main()
{
	print("");
	print("### Running script");
	var layer = josm.layers.get(0); // java will stop us if no dataset present
	var ds = layer.data;
	
	var gtfs = {}; // Contains "stop" objects that look like this: {newEntry: <obj>, oldEntry: <obj>, osmElement: <obj>}
	// Where newEntry is grabbed from the new GTFS, old from the old one, and osmElement from the dataset.
	
	// Read lines from the new gtfs, and fill "gtfs[ref].newEntry"
	{
		var translations_new = main_fillTranslations(DB_DIR+"/new/translations.txt"); // sets FATAL if unknown language detected
		main_fillNewGtfs(gtfs, DB_DIR+"/new/parsed.txt", translations_new); // sets FATAL if some bus stops have the same ref.
	}
	
	// Read lines from the old gtfs, and fill "gtfs[ref].oldEntry"
	{
		var translations_old = main_fillTranslations(DB_DIR+"/old/translations.txt"); // sets FATAL if unknown language detected
		main_fillOldGtfs(gtfs, DB_DIR+"/old/parsed.txt", translations_old); // sets FATAL if some bus stops have the same ref.
	}
	
	// ref -> osmElement dictionary, will be used below to fill "gtfs[ref].osmElement"
	var osm_ref = main_initOsmRef(ds); // sets FATAL if some bus stops have the same ref.
	
	if (FATAL)
	{
		print("### Script canceled");
		return;
	}
	
	// creates a table of stops that already had fixmes added. 
	// We use it to avoid re-adding fixmes when mappers delete them
	// var fixmes = main_fillFixmes(ds,DB_DIR+"/fixmes.txt"); 
	// Also removes gone stops from the table and updates fixmes.txt
	// TODO
	
	// iterate all "gtfs" objects, decide what to do with each. 
	for (var ref in gtfs)
	{
		if (gtfs.hasOwnProperty(ref)) 
		{
			var stop = gtfs[ref]; 
			// stop = {newEntry: <obj or null>, oldEntry: <obj or null>, osmElement: null (or filled below)}
			
			// - - -  => N/A
			if ((stop.oldEntry === null) && (stop.newEntry === null))
			{
				print("FATAL. this should never happen");
				return;
			}
			
			// Fill stop.osmElement. The element returned is also removed from osm_ref
			// May return null
			var match = matchGtfEntryToAnOsmElement(osm_ref, stop); 
			stop.osmElement = match;
			
			// ? ? -
			if (match == null)
			{
				if ((stop.oldEntry === null) && (stop.newEntry !== null))
				{
					printCD("-X-: " + ref + ". Created.");
					gStats.dxd_create++;
					busStopCreate(stop, ds);
				}
				// X - -
				if ((stop.oldEntry !== null) && (stop.newEntry === null))
				{
					printV("X--: " + ref + ". NoAction.");
					gStats.xdd_nothing++;
					gStats.nothing++;
				}
				// X X -
				if ((stop.oldEntry !== null) && (stop.newEntry !== null))
				{
					if (shouldCreateXXD(stop))
					{
						printCD("XX-: " + ref + ". Created.");
						gStats.xxd_create++;
						busStopCreate(stop, ds);
					}
					else
					{
						// XX- NoAction
						print("DESYNC: " + ref + " Stop exists in GTFS but deleted by user.");
						gStats.xxd_nothing++;	
						gStats.nothing++;
					}
				}
			}
			// ? ? X
			else
			{	
				if ((stop.oldEntry === null) && (stop.newEntry !== null))
				{
					printV("-XX: " + ref + ". Updated. osmId=" + match.id);
					gStats.dxx_update++;
					busStopUpdate(stop);
				}
				if ((stop.oldEntry !== null) && (stop.newEntry === null))
				{
					printCD("X-X: " + ref + ". Deleted. osmId=" + match.id);
					gStats.xdx_delete++;
					busStopDelete(stop, layer);
				}
				if ((stop.oldEntry !== null) && (stop.newEntry !== null))
				{
					printV("XXX: " + ref + ". Updated. osmId=" + match.id);
					gStats.xxx_update++;
					busStopUpdate(stop);
				}
			}
		}
	}

	// Whatever is left in osm_ref is // - - X
	for (var ref in osm_ref)
	{
		if (osm_ref.hasOwnProperty(ref))
		{
			var el = osm_ref[ref];
			if ((el.tags["source"] === "israel_gtfs") || (el.tags["source"] === "israel_gtfs_v1"))
			{
				gStats.ddx_del++;
				printCD("--X: " + ref + ". Deleted. Has source=gtfs. osmId=" + el.id);	
				busStopDelete({osmElement: el}, layer);
			}
			else
			{
				// --X: NoAction
				print("DESYNC: " + ref + " Stop only in OSM and no source=gtfs. osmId=" + el.id);	
				gStats.ddx_nothing++;
				gStats.nothing++;
			}
		}
	}
	
	// print stats
	for (var stat in gStats)
	{
		if (gStats.hasOwnProperty(stat))
		{
			print(stat + ": " + gStats[stat]);
		}
	}

	// sanity checks on the stats
	performSanityChecks();

	print("### Script finished");
}

function main_initOsmRef(ds)
{
	var osm_ref = {};
	ds.each(function(p)
	{
			if (p.tags["highway"] !== "bus_stop") return;
			var ref = p.tags["ref"];
			if (ref === undefined) return;
			gStats.total_OsmBeforeRun++;
			if (osm_ref[ref] === undefined)
			{
				osm_ref[ref] = p;
			}
			else
			{
				FATAL = true;
				print("FATAL: multiple bus stops with ref " + ref);
				return null;
			}			
	});
	gStats.total_OsmAfterRun = gStats.total_OsmBeforeRun;
	return osm_ref;
}

function main_fillTranslations(file)
{
	var translationObject = {en : {}, ar: {}};
	readFile_forEach(file, function(javaLine)
	{
		var line = javaLine + "";
		var arr = line.split(",");
		var original = arr[0].trim();
		var language = arr[1].toLowerCase().trim();
		if (language == "he") return;
		var translation = arr[2].trim();
		if (translationObject[language] === undefined) {FATAL = true; print("Unexpected translation language: " + language);return;}
		translationObject[language][original] = translation;
	});
	return translationObject;
}

function main_fillNewGtfs(gtfs, path, translations)
{
	readFile_forEach(path, function(javaLine)
	{
		var line = javaLine+"";
		var newE = lineToGtfsEntry(line);
		if (newE === null) return;
		var ref = newE["ref"];
		if (gtfs[ref] !== undefined)
		{
			return; // todo handle platforms
			print("FATAL: Two gtfs entries with same ref in new db: " + ref);
			FATAL = true;
		}
		gStats.total_newGTFS++;
		gtfs[ref] = {newEntry: newE, oldEntry: null, osmElement: null};
		newE["name:en"] = translations["en"][newE.name]; // could be undefined
		newE["name:ar"] = translations["ar"][newE.name]; // could be undefined
	});
}

function main_fillOldGtfs(gtfs, path, translations)
{
	readFile_forEach(path, function(javaLine)
	{
		var line = javaLine+"";
		var oldE = lineToGtfsEntry(line);
		if (oldE === null) return;
		var ref = oldE["ref"];
		if (gtfs[ref] === undefined)
		{
				gtfs[ref] = {newEntry: null, oldEntry: null, osmElement: null};
		}
		if (gtfs[ref].oldEntry !== null)
		{
			return; // todo handle platforms
			print("FATAL: Two gtfs entries with same ref in old db: " + ref);
			FATAL = true;
		}
		gStats.total_oldGTFS++;
		gtfs[ref].oldEntry = oldE;
		oldE["name:en"] = translations["en"][oldE.name]; // could be undefined
		oldE["name:ar"] = translations["ar"][oldE.name]; // could be undefined
	});
}
	


////////////////////////////// gtfs and osm functions



function matchGtfEntryToAnOsmElement(osm_ref, stop)
{
		var entry = (stop.newEntry === null ? stop.oldEntry : stop.newEntry);
		var ref = entry["ref"];
		var matchingOsmElement = osm_ref[ref];
		if (matchingOsmElement === undefined)
		{
			return null;
		}
		else
		{
			delete osm_ref[ref];
			return matchingOsmElement;
		}
}

function setIfNotSetAndChanged(key, stop, isCreated)
{
	// Only touch the values that:
	// 1. have been either changed between old db and new db
	// 2. don't exist in old db
	// 3. for a created stop
	if (isCreated || (stop.oldEntry === null) || (stop.oldEntry[key] !== stop.newEntry[key]))
	{
		var value = stop.newEntry[key];
		if (stop.osmElement.tags[key] !== value)
		{
			if (value !== undefined)
			{
				stop.osmElement.tags[key] = value;
			}
			else if (!isCreated)
			{
				// not sure if it ever happens.
				// could happen if a bad translation is removed from gtfs file
				stop.osmElement.removeTag(key);
			}
			return true;
		}
	}
	//else if ((stop.oldEntry !== null) && (stop.oldEntry[key] === stop.newEntry[key]) && (stop.newEntry[key] !== stop.osmElement.tags[key]))
	if (stop.newEntry[key] !== stop.osmElement.tags[key]) // TODO same logic. right?
	{
		// XXX - NoAction
		print("DESYNC: " + stop.osmElement.tags.ref + " Value desync." + 
		" key=" + key +
		", gtfsVal=" + stop.oldEntry[key] + 
		", osmVal=" + stop.osmElement.tags[key] +
		", osmId=" + stop.osmElement.id);
	}
	return false;
}

// set on an osm element, regardless of gtfs files. 
// Use this for stuff that have no gtfs file values (e.g. shelter, source, etc)
function setRaw(osmElement, key, value)
{
	if (osmElement.tags[key] !== value)
	{
		osmElement.tags[key] = value;
		return true;
	}
	return false;
}

function shouldCreateXXD(stop)
{
	// this stop exists in old and new gtfs files
	// but doesn't exist in OSM, meaning a user deleted it
	// If it hasn't changed since then, we shouldn't recreate it
	// Otherwise, we should. (We always trust the most recent change)
	
	for (var key in stop.oldEntry)
	{
		if (stop.oldEntry.hasOwnProperty(key))
		{
			if (stop.oldEntry[key] !== stop.newEntry[key]) return true;
		}
	}
	/*print("these are identical");
	printObj(stop.oldEntry);
	printObj(stop.newEntry);*/
	return false;
}

function busStopUpdate(stop, isCreated)
{
	
	if (isCreated === undefined)
	{
		isCreated = false;
		gStats.update++;
	}
	
	// These checks are probably useless on first run. There have been major changes since 2012. Almost all "warnings" are expected to be false positives.
	/*if (!isCreated)
	{
	* 
		var distance = getDistanceFromLatLonInM(stop.newEntry.lat, stop.newEntry.lon, stop.osmElement.lat, stop.osmElement.lon);
		if (distance > 50)
		{
			// the bus stop is about to be moved more than 50 meters, something could be wrong
			
			if ((stop.oldEntry != null) && (getDistanceFromLatLonInM(stop.oldEntry.lat, stop.oldEntry.lon, stop.osmElement.lat, stop.osmElement.lon) < 20))
			{
				// The distance difference happened due to difference from the older database, continue
				print("INFO: bus stop " + distance + "m from where it should be. Continued anyways. ref: " + stop.osmElement.tags["ref"] + " id: " + stop.osmElement.id);
				stop.osmElement.tags["DEBUG111"] = "debug";
				gStats.update_distanceTooFar_ignored++;
			}
			else
			{
				// The distance difference happened because a mapper moved this stop. The mapper and the GTFS DB disagree significantly. Warn!
				print("WARN: bus stop " + distance + "m from where it should be. Skipped. ref: " 
					+ stop.osmElement.tags["ref"] + " id: " + stop.osmElement.id);
				gStats.update_not_touched++;
				stop.osmElement.tags["DEBUG222"] = "debug";
				gStats.update_distanceTooFar_skipped++;
				return false;
			}
		}

	}*/
	
	var touched = false;
	touched = setIfNotSetAndChanged("ref", stop, isCreated) || touched;
	touched = setIfNotSetAndChanged("name",stop, isCreated) || touched;
	touched = setIfNotSetAndChanged("name:he",stop, isCreated) || touched;
	touched = setIfNotSetAndChanged("name:en",stop, isCreated) || touched;
	touched = setIfNotSetAndChanged("name:ar",stop, isCreated) || touched;
	touched = setIfNotSetAndChanged("description", stop, isCreated) || touched;
	
	if (isCreated)
	{
		setRaw(stop.osmElement, "source", "israel_gtfs");
		setRaw(stop.osmElement, "gtfs:verified", "no");
		return;
	}
	
	// modified (non created) stops only:
	
	if ((stop.oldEntry === null) || (stop.oldEntry["lat"] !== stop.newEntry["lat"]) || (stop.oldEntry["lon"] !== stop.newEntry["lon"]))
	{
		if ((stop.osmElement.lat !== stop.newEntry.lat) || (stop.osmElement.lon !== stop.newEntry.lon))
		{
			stop.osmElement.pos = {lat: stop.newEntry.lat, lon: stop.newEntry.lon};
			touched = true;
		}
	}
	
	if ((stop.newEntry["lat"] != stop.osmElement.lat) || (stop.newEntry["lon"] != stop.osmElement.lon))
	{
		var distance = getDistanceFromLatLonInM(stop.newEntry.lat, stop.newEntry.lon, stop.osmElement.lat, stop.osmElement.lon).toFixed(2);
		print("DESYNC " + distance + "m: " + stop.osmElement.tags.ref + " spacial desync. osm=("+
		stop.osmElement.lon+","+stop.osmElement.lat+"), gtfs=("+stop.newEntry.lon+","+stop.newEntry.lat+")");
	}
	
	if (touched)
	{
		setRaw(stop.osmElement, "gtfs:verified", "no");
	}
	
	touched = setRaw(stop.osmElement, "source", "israel_gtfs") || touched;
	
	if (touched)
	{
		gStats.update_touched++;
		gStats.touched++;
	}
	else
	{
		gStats.update_not_touched++;
	}
}

function busStopCreate(stop, ds)
{
	gStats.create++;
	gStats.touched++;
	gStats.total_OsmAfterRun++;
	var nb = builder.NodeBuilder;
	var node = nb.create({lat: stop.newEntry.lat, lon: stop.newEntry.lon});
	ds.add(node);
	stop.osmElement = node;
	node.tags.highway = "bus_stop";
	busStopUpdate(stop, true);
}

function busStopDelete(stop, layer)
{
	gStats.del++;
	gStats.touched++;
	gStats.total_OsmAfterRun--;
	del(stop.osmElement, layer);
}



////////////////////////////// Other



function performSanityChecks()
{
	var s = gStats;
	if (s.ddx_del + s.xdx_delete != s.del) print("ASSERT FAIL - delete");
	if (s.dxd_create + s.xxd_create != s.create) print("ASSERT FAIL - create");
	if (s.dxx_update + s.xxx_update != s.update) print("ASSERT FAIL - update");
	if (s.update_touched + s.create + s.del != s.touched) print("ASSERT FAIL - touches");
	if (s.total_OsmBeforeRun + s.create - s.del != s.total_OsmAfterRun) 
		print("ASSERT FAIL - beforeAfter" + s.total_OsmBeforeRun + "+" + s.create + "-" + s.del + "=" + s.total_OsmAfterRun);
	if (s.ddx_nothing + s.xdd_nothing + s.xxd_nothing != s.nothing) print("ASSERT FAIL - nothing");
	if (s.update_touched + s.update_not_touched != s.update) print("ASSERT FAIL - updateTouches");
	if (s.total_newGTFS + s.ddx_nothing - s.xxd_nothing != s.total_OsmAfterRun) print("ASSERT FAIL - finalBusStopSum");
}

main();
})();
