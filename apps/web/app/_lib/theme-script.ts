export const THEME_KEY = "panel_theme";

/** Inline script in <head>: zet het thema vóór de eerste paint (standaard dark, geen flits). */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");var d=document.documentElement;if(t==="light"){d.classList.remove("dark");d.classList.add("light")}else{d.classList.add("dark");d.classList.remove("light")}}catch(e){}`;

