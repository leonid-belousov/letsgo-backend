import { Module } from '@nestjs/common';
import { RecentSearchService } from './recent.service';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({ controllers: [SearchController], providers: [SearchService, RecentSearchService] })
export class SearchModule {}
