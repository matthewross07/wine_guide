# Moves data between the Google Sheet and this repo.
#
#   Rscript scripts/sheet-sync.R pull   # sheet  -> scratch CSV for assign-layout.mjs
#   Rscript scripts/sheet-sync.R push   # data/wines.json ids + locations -> sheet
#
# `push` is for the initial setup: it backs up Sheet1 to a dated tab, adds the
# id / locations / my_rating / my_notes columns, and creates the tasting_log tab.
# After that the website writes to the sheet through the Apps Script.

suppressMessages({
  library(googlesheets4)
  library(jsonlite)
})

ss <- "https://docs.google.com/spreadsheets/d/1RoWc10V9BvBuWv6BeCtFXqwBXpUJ-BlxL7Etpotx_rg/edit"
options(gargle_oauth_email = Sys.getenv("WINE_GOOGLE_EMAIL", TRUE))

mode <- commandArgs(trailingOnly = TRUE)[1]

if (identical(mode, "pull")) {
  out <- commandArgs(trailingOnly = TRUE)[2]
  if (is.na(out)) out <- "wines_export.csv"
  wines <- read_sheet(ss, sheet = "Sheet1", col_types = "c")
  write.csv(wines, out, row.names = FALSE, na = "")
  message("wrote ", out, " (", nrow(wines), " wines)")

} else if (identical(mode, "push")) {
  plan <- fromJSON("data/wines.json")$wines
  current <- read_sheet(ss, sheet = "Sheet1", col_types = "c")
  stopifnot(nrow(current) == nrow(plan), all(current$wine_name == plan$wine_name))

  backup <- paste0("Sheet1_backup_", format(Sys.Date(), "%Y%m%d"))
  if (!backup %in% sheet_names(ss)) {
    sheet_copy(from_ss = ss, from_sheet = "Sheet1", to_ss = ss, to_sheet = backup)
    message("backed up Sheet1 to ", backup)
  }

  keep <- function(col) if (col %in% names(current)) current[[col]] else rep(NA_character_, nrow(current))
  extra <- data.frame(
    id = plan$id,
    locations = plan$locations,
    my_rating = keep("my_rating"),
    my_notes = keep("my_notes")
  )
  base_cols <- setdiff(names(current), names(extra))
  start <- LETTERS[length(base_cols) + 1]
  range_write(ss, extra, sheet = "Sheet1", range = paste0(start, "1"), col_names = TRUE, reformat = FALSE)
  message("wrote id/locations/my_rating/my_notes starting at column ", start)

  if (!"tasting_log" %in% sheet_names(ss)) {
    log <- data.frame(
      logged_at = character(), date = character(), event = character(), id = character(),
      wine_name = character(), vintage = character(), rating = character(),
      notes = character(), food = character(), slot = character()
    )
    sheet_write(log, ss, sheet = "tasting_log")
    message("created tasting_log tab")
  }

} else {
  stop("usage: Rscript scripts/sheet-sync.R pull [out.csv] | push")
}
